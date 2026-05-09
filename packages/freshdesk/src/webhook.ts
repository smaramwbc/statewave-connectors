// `createFreshdeskWebhookHandler` — Freshdesk webhook receiver. Same
// shape as the Slack handler: a pure `(Request) => Promise<Response>`
// that verifies a shared-secret header, dedups retries by `event_id`
// (or a synthesized fallback), maps the inbound payload to a Statewave
// episode, and ingests it.
//
// Auth model: Freshdesk webhooks don't have a native HMAC signature
// like Slack's. Instead, the operator configures a custom header in
// Freshdesk's webhook step (Admin → Workflows → Automations → Webhook
// → Custom Headers) carrying the shared secret. The handler does a
// constant-time compare against the configured value before processing.
//
// Episode kinds dispatched (mirror the pull-mode shapes):
//   ticket.created → freshdesk.ticket.created
//   ticket.resolved (or status=4/5) → freshdesk.ticket.resolved
//   ticket.updated → routed by status (created vs resolved)
//   comment.added (private=false) → freshdesk.conversation.posted
//   comment.added (private=true)  → freshdesk.conversation.internal_note

import { ConnectorError, type StatewaveEpisode } from "@statewavedev/connectors-core";
import { mapFreshdeskEvent } from "./mapper.js";
import {
  FRESHDESK_STATUS_BY_CODE,
  type FreshdeskCompany,
  type FreshdeskConversation,
  type FreshdeskEvent,
  type FreshdeskTicket,
  type FreshdeskUser,
} from "./types.js";
import {
  type FreshdeskDedupCache,
  InMemoryFreshdeskDedupCache,
} from "./webhook-dedup.js";
import type { FreshdeskWebhookComment, FreshdeskWebhookPayload, FreshdeskWebhookTicket } from "./webhook-types.js";

/** Shape of the ingest sink. Same contract as the Slack receiver. */
export type StatewaveIngest = (episode: StatewaveEpisode) => Promise<void>;

export interface FreshdeskWebhookConfig {
  /**
   * Shared secret the Freshdesk webhook step sends as a custom header
   * (default `X-Statewave-Token`). Constant-time compared against the
   * configured value. Required.
   */
  signingSecret: string;
  /**
   * Header name carrying the shared secret. Default `x-statewave-token`
   * (Node lowercases all incoming headers; the comparison is
   * case-insensitive on the lookup but exact on the value). Override
   * if your operator already standardized on a different header name.
   */
  signingHeader?: string;
  /**
   * Subdomain — used to mint browser permalinks like
   * `https://acme.freshdesk.com/a/tickets/123` on emitted episodes.
   * Optional; if omitted, episodes carry no permalink (Freshdesk's
   * webhook payload doesn't include the API URL by default).
   */
  subdomain?: string;
  /** Override subject. Defaults to `customer:<company_or_requester_id>` per ticket. */
  subject?: string;
  /** Where to ship the resulting episode. Required unless `ingest` is provided. */
  statewaveUrl?: string;
  statewaveApiKey?: string;
  statewaveTenantId?: string;
  /** Custom ingest sink — overrides the built-in HTTP one. */
  ingest?: StatewaveIngest;
  /** Replace the default in-memory dedup cache. */
  dedupCache?: FreshdeskDedupCache;
  /** Logger sink — defaults to console.error. */
  logger?: (level: "info" | "warn" | "error", msg: string, ctx?: unknown) => void;
  /** Inject `fetch` for tests + non-Node runtimes. */
  fetchImpl?: typeof fetch;
}

export interface FreshdeskWebhookHandler {
  (req: Request): Promise<Response>;
  readonly dedupCache: FreshdeskDedupCache;
}

export function createFreshdeskWebhookHandler(
  config: FreshdeskWebhookConfig,
): FreshdeskWebhookHandler {
  if (!config.signingSecret) {
    throw new ConnectorError(
      "createFreshdeskWebhookHandler requires signingSecret (shared secret the operator configures in Freshdesk's webhook custom-header step)",
      { code: "config_invalid", connector: "freshdesk" },
    );
  }
  if (!config.ingest && !config.statewaveUrl) {
    throw new ConnectorError(
      "createFreshdeskWebhookHandler requires statewaveUrl or a custom ingest sink",
      { code: "config_invalid", connector: "freshdesk" },
    );
  }

  const dedupCache = config.dedupCache ?? new InMemoryFreshdeskDedupCache();
  const headerName = (config.signingHeader ?? "x-statewave-token").toLowerCase();
  const ingest = config.ingest ?? buildHttpIngest(config);
  const logger = config.logger ?? defaultLogger;

  const handler = (async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    const headerValue = req.headers.get(headerName);
    if (!headerValue || !constantTimeEqual(headerValue, config.signingSecret)) {
      return jsonResponse({ error: "bad_signature" }, 401);
    }

    let body: string;
    try {
      body = await req.text();
    } catch (err) {
      logger("warn", "freshdesk webhook body read failed", { err: String(err) });
      return jsonResponse({ error: "body_read_failed" }, 400);
    }

    let payload: FreshdeskWebhookPayload;
    try {
      payload = JSON.parse(body) as FreshdeskWebhookPayload;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    if (!payload?.ticket?.id) {
      return jsonResponse({ ok: true, ignored: "missing_ticket" }, 200);
    }

    const eventId = payload.event_id ?? synthesizeEventId(payload);
    const seen = await dedupCache.seenOrMark(eventId);
    if (seen) {
      return jsonResponse({ ok: true, deduplicated: true }, 200);
    }

    const event = mapInboundEvent(payload, config);
    if (!event) {
      return jsonResponse({ ok: true, ignored: "unknown_event" }, 200);
    }

    const episode = mapFreshdeskEvent(event, {
      subject: config.subject,
      subdomain: config.subdomain,
    });

    try {
      await ingest(episode);
    } catch (err) {
      // Always 200 on ingest failure — Freshdesk would retry on
      // non-2xx and the next retry would rejoin our dedup window.
      // Operators see ingest failures via the logger sink.
      logger("error", "freshdesk webhook ingest failed", {
        ticket_id: payload.ticket.id,
        event_id: eventId,
        err: String(err),
      });
    }

    return jsonResponse({ ok: true, ingested: true }, 200);
  }) as FreshdeskWebhookHandler;
  Object.defineProperty(handler, "dedupCache", { value: dedupCache, enumerable: true });
  return handler;
}

/**
 * Translate the inbound webhook payload into a `FreshdeskEvent` the
 * shared mapper consumes. Returns null for unrecognised event types
 * so the caller can ack-and-skip rather than 4xx-ing on benign
 * unrecognised triggers.
 */
function mapInboundEvent(
  payload: FreshdeskWebhookPayload,
  _config: FreshdeskWebhookConfig,
): FreshdeskEvent | null {
  const ticket = adoptWebhookTicket(payload.ticket);
  const requester = inferRequester(ticket);
  const company = inferCompany(ticket);

  if (payload.event === "comment.added" && payload.comment) {
    const conversation = adoptWebhookComment(payload.comment, ticket.id);
    return { type: "conversation", ticket, conversation, requester, company };
  }
  if (payload.event === "ticket.created") {
    return { type: "ticket.created", ticket, requester, company };
  }
  if (payload.event === "ticket.resolved") {
    return { type: "ticket.resolved", ticket, requester, company };
  }
  if (payload.event === "ticket.updated") {
    // Updated tickets route by current status — same shape pull mode
    // uses when it discovers a ticket already in solved/closed state.
    if (ticket.status === "resolved" || ticket.status === "closed") {
      return { type: "ticket.resolved", ticket, requester, company };
    }
    return { type: "ticket.created", ticket, requester, company };
  }
  return null;
}

function adoptWebhookTicket(t: FreshdeskWebhookTicket): FreshdeskTicket {
  const status =
    typeof t.status === "number" ? FRESHDESK_STATUS_BY_CODE[t.status] ?? "custom" : undefined;
  return {
    id: t.id,
    subject: t.subject ?? null,
    description_text: t.description_text ?? null,
    status,
    status_code: typeof t.status === "number" ? t.status : undefined,
    priority: t.priority ?? null,
    type: t.type ?? null,
    tags: t.tags ?? [],
    requester_id: t.requester_id ?? null,
    responder_id: t.responder_id ?? null,
    company_id: t.company_id ?? null,
    group_id: t.group_id ?? null,
    product_id: t.product_id ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function adoptWebhookComment(c: FreshdeskWebhookComment, ticketId: number): FreshdeskConversation {
  return {
    id: c.id,
    ticket_id: ticketId,
    private: !!c.private,
    body_text: c.body_text ?? null,
    user_id: c.user_id ?? null,
    incoming: undefined,
    source: c.source ?? null,
    created_at: c.created_at,
  };
}

/**
 * The mapper renders the requester label from a `FreshdeskUser`. When
 * the webhook payload doesn't include the requester record (just an
 * id), we surface the id and let the mapper fall back to its
 * `requester:<id>` label format. Best-effort enrichment via the API
 * is queued for v0.1.4 — it would require a synchronous API call per
 * webhook hit.
 */
function inferRequester(ticket: FreshdeskTicket): FreshdeskUser | undefined {
  if (!ticket.requester_id) return undefined;
  return { id: ticket.requester_id };
}

function inferCompany(ticket: FreshdeskTicket): FreshdeskCompany | undefined {
  if (!ticket.company_id) return undefined;
  return { id: ticket.company_id };
}

/**
 * Synthesize a stable id when the operator didn't include `event_id`
 * in the webhook config. Ticket id + updated_at uniquely identifies
 * a ticket-state-change event in the common case; comment.added events
 * append the comment id so two same-second comments don't collide.
 */
function synthesizeEventId(payload: FreshdeskWebhookPayload): string {
  const base = `freshdesk:${payload.ticket.id}:${payload.ticket.updated_at}`;
  if (payload.event === "comment.added" && payload.comment) {
    return `${base}:comment:${payload.comment.id}`;
  }
  return `${base}:${payload.event}`;
}

/** Constant-time string compare so timing leaks don't reveal the secret. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function buildHttpIngest(config: FreshdeskWebhookConfig): StatewaveIngest {
  const url = config.statewaveUrl;
  if (!url) {
    throw new ConnectorError("statewaveUrl required when ingest is not provided", {
      code: "config_invalid",
      connector: "freshdesk",
    });
  }
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  return async (episode: StatewaveEpisode) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.statewaveApiKey) headers.authorization = `Bearer ${config.statewaveApiKey}`;
    if (config.statewaveTenantId) headers["x-statewave-tenant-id"] = config.statewaveTenantId;
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/v1/episodes`, {
      method: "POST",
      headers,
      body: JSON.stringify(episode),
    });
    if (!res.ok) {
      throw new Error(`statewave ingest returned HTTP ${res.status}`);
    }
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const defaultLogger: NonNullable<FreshdeskWebhookConfig["logger"]> = (level, msg, ctx) => {
  const line = ctx === undefined ? msg : `${msg} ${JSON.stringify(ctx)}`;
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.error)(line);
};
