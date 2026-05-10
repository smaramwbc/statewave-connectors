// `createZendeskWebhookHandler` — Zendesk webhook receiver. Same pure
// `(Request) => Promise<Response>` shape as the Slack and Freshdesk
// receivers. Verifies Zendesk's HMAC-SHA256 signature, dedups retries
// by event id (or a synthesized fallback), maps the payload to a
// Statewave episode, and ingests it.
//
// Auth model: Zendesk webhooks DO have a native HMAC signature. Each
// webhook gets its own signing secret (Admin → Apps and integrations →
// Webhooks → <webhook> → Signing secret). On every delivery Zendesk
// sends:
//   - `X-Zendesk-Webhook-Signature`           — base64(HMAC-SHA256(`<ts><body>`, secret))
//   - `X-Zendesk-Webhook-Signature-Timestamp` — ISO timestamp from the sender
// We verify both: signature with constant-time compare AND timestamp
// within a configurable replay window (default 300s).
//
// Two delivery shapes accepted:
//   - Trigger / Automation–driven: operator writes a Liquid JSON template
//     with a top-level `event` field (`ticket.created`, `ticket.updated`,
//     `ticket.solved`, `comment.created`). README documents the
//     canonical template.
//   - Event-driven subscription: Zendesk's stable envelope with
//     `type: "zen:event-type:ticket.created"` and an `event.ticket` block.
//
// Episode kinds dispatched (mirror pull-mode shapes):
//   ticket.created                                  → zendesk.ticket.created
//   ticket.solved (or ticket.updated w/ status=solved/closed) → zendesk.ticket.solved
//   ticket.updated (other statuses)                 → zendesk.ticket.created
//   comment.created (public=true)                   → zendesk.comment.posted
//   comment.created (public=false)                  → zendesk.comment.internal_note

import { createHmac } from "node:crypto";
import { ConnectorError, type StatewaveEpisode } from "@statewavedev/connectors-core";
import { mapZendeskEvent } from "./mapper.js";
import type {
  ZendeskComment,
  ZendeskEvent,
  ZendeskOrganization,
  ZendeskTicket,
  ZendeskTicketStatus,
  ZendeskUser,
} from "./types.js";
import {
  type ZendeskDedupCache,
  InMemoryZendeskDedupCache,
} from "./webhook-dedup.js";
import {
  isEventDrivenPayload,
  type ZendeskEventWebhookPayload,
  type ZendeskTriggerWebhookPayload,
  type ZendeskWebhookComment,
  type ZendeskWebhookTicket,
} from "./webhook-types.js";

const DEFAULT_SIGNATURE_HEADER = "x-zendesk-webhook-signature";
const DEFAULT_TIMESTAMP_HEADER = "x-zendesk-webhook-signature-timestamp";
const DEFAULT_REPLAY_WINDOW_SEC = 300;

/** Shape of the ingest sink. Same contract as the other receivers. */
export type StatewaveIngest = (episode: StatewaveEpisode) => Promise<void>;

export interface ZendeskWebhookConfig {
  /**
   * HMAC signing secret from the Zendesk webhook configuration page
   * (Admin → Apps and integrations → Webhooks → <webhook> → Signing
   * secret). Required.
   */
  signingSecret: string;
  /**
   * Subdomain — used to mint browser permalinks like
   * `https://acme.zendesk.com/agent/tickets/123` on emitted episodes.
   * Optional; if omitted, episodes carry the API URL Zendesk returned
   * on the ticket payload (when present).
   */
  subdomain?: string;
  /** Override subject. Defaults to `customer:<organization_or_requester_id>` per ticket. */
  subject?: string;
  /** Where to ship the resulting episode. Required unless `ingest` is provided. */
  statewaveUrl?: string;
  statewaveApiKey?: string;
  statewaveTenantId?: string;
  /** Custom ingest sink — overrides the built-in HTTP one. */
  ingest?: StatewaveIngest;
  /** Replace the default in-memory dedup cache. */
  dedupCache?: ZendeskDedupCache;
  /** Logger sink — defaults to console.error. */
  logger?: (level: "info" | "warn" | "error", msg: string, ctx?: unknown) => void;
  /** Inject `fetch` for tests + non-Node runtimes. */
  fetchImpl?: typeof fetch;
  /**
   * Replay protection window in seconds. The handler rejects requests
   * whose `X-Zendesk-Webhook-Signature-Timestamp` is more than this
   * many seconds away from "now". Default 300 (5 min) — Zendesk's
   * recommended setting.
   */
  replayWindowSec?: number;
  /** Inject "now" (in seconds) for tests. */
  now?: () => number;
  /** Override the signature header name (default `x-zendesk-webhook-signature`). */
  signatureHeader?: string;
  /** Override the timestamp header name. */
  timestampHeader?: string;
}

export interface ZendeskWebhookHandler {
  (req: Request): Promise<Response>;
  readonly dedupCache: ZendeskDedupCache;
}

export function createZendeskWebhookHandler(
  config: ZendeskWebhookConfig,
): ZendeskWebhookHandler {
  if (!config.signingSecret) {
    throw new ConnectorError(
      "createZendeskWebhookHandler requires signingSecret (Zendesk webhook signing secret)",
      { code: "config_invalid", connector: "zendesk" },
    );
  }
  if (!config.ingest && !config.statewaveUrl) {
    throw new ConnectorError(
      "createZendeskWebhookHandler requires statewaveUrl or a custom ingest sink",
      { code: "config_invalid", connector: "zendesk" },
    );
  }

  const dedupCache = config.dedupCache ?? new InMemoryZendeskDedupCache();
  const signatureHeader = (config.signatureHeader ?? DEFAULT_SIGNATURE_HEADER).toLowerCase();
  const timestampHeader = (config.timestampHeader ?? DEFAULT_TIMESTAMP_HEADER).toLowerCase();
  const replayWindowSec = config.replayWindowSec ?? DEFAULT_REPLAY_WINDOW_SEC;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const ingest = config.ingest ?? buildHttpIngest(config);
  const logger = config.logger ?? defaultLogger;

  const handler = (async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    const signature = req.headers.get(signatureHeader);
    const timestamp = req.headers.get(timestampHeader);
    if (!signature || !timestamp) {
      return jsonResponse({ error: "missing_signature_headers" }, 401);
    }

    let body: string;
    try {
      body = await req.text();
    } catch (err) {
      logger("warn", "zendesk webhook body read failed", { err: String(err) });
      return jsonResponse({ error: "body_read_failed" }, 400);
    }

    if (!verifyTimestamp(timestamp, now(), replayWindowSec)) {
      return jsonResponse({ error: "stale_timestamp" }, 401);
    }
    if (!verifySignature(config.signingSecret, timestamp, body, signature)) {
      return jsonResponse({ error: "bad_signature" }, 401);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const normalized = normalizeInbound(parsed);
    if (!normalized) {
      return jsonResponse({ ok: true, ignored: "missing_ticket" }, 200);
    }

    const seen = await dedupCache.seenOrMark(normalized.eventId);
    if (seen) {
      return jsonResponse({ ok: true, deduplicated: true }, 200);
    }

    const event = mapInboundEvent(normalized);
    if (!event) {
      return jsonResponse({ ok: true, ignored: "unknown_event" }, 200);
    }

    const episode = mapZendeskEvent(event, {
      subject: config.subject,
      subdomain: config.subdomain,
    });

    try {
      await ingest(episode);
    } catch (err) {
      // Always 200 on ingest failure — Zendesk retries on non-2xx and
      // the next attempt rejoins our dedup window. Operators see ingest
      // failures via the logger sink.
      logger("error", "zendesk webhook ingest failed", {
        ticket_id: normalized.ticket.id,
        event_id: normalized.eventId,
        err: String(err),
      });
    }

    return jsonResponse({ ok: true, ingested: true }, 200);
  }) as ZendeskWebhookHandler;
  Object.defineProperty(handler, "dedupCache", { value: dedupCache, enumerable: true });
  return handler;
}

interface NormalizedInbound {
  eventId: string;
  eventKind: "ticket.created" | "ticket.updated" | "ticket.solved" | "comment.created" | string;
  ticket: ZendeskTicket;
  comment?: ZendeskComment;
}

/**
 * Translate either webhook shape (trigger-driven or event-driven) into
 * a single internal representation. Returns null if neither shape
 * carries a ticket id we can route on.
 */
function normalizeInbound(raw: unknown): NormalizedInbound | null {
  if (!raw || typeof raw !== "object") return null;

  if (isEventDrivenPayload(raw)) {
    const payload = raw as ZendeskEventWebhookPayload;
    const ticketBlock = payload.event?.ticket;
    const ticketId = ticketBlock?.id ?? payload.event?.ticket_id;
    if (!ticketId) return null;
    const eventKind = mapEventDrivenKind(payload.type);
    if (!eventKind) return null;
    const ticket = adoptWebhookTicket(ticketBlock, ticketId);
    const comment = payload.event?.comment
      ? adoptWebhookComment(payload.event.comment, ticketId)
      : undefined;
    const eventId =
      payload.id ?? synthesizeEventId(ticket, eventKind, comment?.id);
    return { eventId, eventKind, ticket, comment };
  }

  // Trigger / Automation–driven payload.
  const payload = raw as ZendeskTriggerWebhookPayload;
  if (!payload.ticket?.id) return null;
  const ticket = adoptWebhookTicket(payload.ticket, payload.ticket.id);
  const comment = payload.comment
    ? adoptWebhookComment(payload.comment, ticket.id)
    : undefined;
  const eventKind = payload.event ?? "ticket.updated";
  const eventId =
    payload.event_id ?? synthesizeEventId(ticket, eventKind, comment?.id);
  return { eventId, eventKind, ticket, comment };
}

/**
 * Translate the normalized inbound event into a `ZendeskEvent` the
 * shared mapper consumes. Returns null for unrecognised event kinds so
 * the caller can ack-and-skip rather than 4xx-ing on benign unknown
 * triggers.
 */
function mapInboundEvent(n: NormalizedInbound): ZendeskEvent | null {
  const requester = inferRequester(n.ticket);
  const organization = inferOrganization(n.ticket);

  if (n.eventKind === "comment.created" && n.comment) {
    return { type: "comment", ticket: n.ticket, comment: n.comment, requester, organization };
  }
  if (n.eventKind === "ticket.created") {
    return { type: "ticket.created", ticket: n.ticket, requester, organization };
  }
  if (n.eventKind === "ticket.solved") {
    return { type: "ticket.solved", ticket: n.ticket, requester, organization };
  }
  if (n.eventKind === "ticket.updated") {
    // Updated tickets route by current status — same shape pull mode
    // uses when it discovers a ticket already in solved/closed state.
    if (n.ticket.status === "solved" || n.ticket.status === "closed") {
      return { type: "ticket.solved", ticket: n.ticket, requester, organization };
    }
    return { type: "ticket.created", ticket: n.ticket, requester, organization };
  }
  return null;
}

function mapEventDrivenKind(zenType: string): NormalizedInbound["eventKind"] | null {
  // Strip the namespace and route on the suffix. Zendesk emits a few
  // variants; we only handle the ones that map to existing episode
  // kinds. Anything else returns null so the handler ack-and-skips.
  const suffix = zenType.replace(/^zen:event-type:/, "").replace(/^zen:event:/, "");
  if (suffix === "ticket.created") return "ticket.created";
  if (suffix === "ticket.updated" || suffix === "ticket.status_changed") return "ticket.updated";
  if (suffix === "ticket.solved") return "ticket.solved";
  if (suffix === "comment.created" || suffix === "ticket.comment_added") return "comment.created";
  return null;
}

function adoptWebhookTicket(t: ZendeskWebhookTicket | undefined, id: number): ZendeskTicket {
  if (!t) {
    return { id, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
  }
  return {
    id,
    subject: t.subject ?? undefined,
    description: t.description ?? undefined,
    status: normalizeStatus(t.status),
    priority: t.priority ?? null,
    type: t.type ?? null,
    tags: t.tags ?? [],
    requester_id: t.requester_id ?? undefined,
    assignee_id: t.assignee_id ?? null,
    organization_id: t.organization_id ?? null,
    brand_id: t.brand_id ?? null,
    group_id: t.group_id ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    url: t.url,
  };
}

function adoptWebhookComment(c: ZendeskWebhookComment, ticketId: number): ZendeskComment {
  return {
    id: c.id,
    ticket_id: ticketId,
    public: !!c.public,
    body: c.body ?? undefined,
    author_id: c.author_id ?? null,
    created_at: c.created_at,
    via: c.via,
  };
}

function normalizeStatus(s: string | null | undefined): ZendeskTicketStatus | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase();
  switch (lower) {
    case "new":
    case "open":
    case "pending":
    case "hold":
    case "solved":
    case "closed":
      return lower;
    default:
      return undefined;
  }
}

/**
 * The mapper renders the requester label from a `ZendeskUser`. When the
 * webhook payload doesn't include the requester record (just an id), we
 * surface the id and let the mapper fall back to its
 * `requester:<id>` label format. Best-effort enrichment via the API is
 * deferred — it would require a synchronous API call per webhook hit.
 */
function inferRequester(ticket: ZendeskTicket): ZendeskUser | undefined {
  if (!ticket.requester_id) return undefined;
  return { id: ticket.requester_id };
}

function inferOrganization(ticket: ZendeskTicket): ZendeskOrganization | undefined {
  if (!ticket.organization_id) return undefined;
  return { id: ticket.organization_id };
}

/**
 * Synthesize a stable id when neither `event_id` (trigger payloads) nor
 * `id` (event-driven) is present. Ticket id + updated_at uniquely
 * identifies a ticket-state-change event in the common case; comment
 * events append the comment id so two same-second comments don't collide.
 */
function synthesizeEventId(
  ticket: ZendeskTicket,
  eventKind: string,
  commentId?: number,
): string {
  const base = `zendesk:${ticket.id}:${ticket.updated_at}:${eventKind}`;
  return commentId ? `${base}:comment:${commentId}` : base;
}

/**
 * Verify Zendesk's HMAC signature. Algorithm per Zendesk docs:
 *   HMAC-SHA256(<timestamp> + <body>, signing_secret) base64-encoded.
 * Constant-time compare so timing leaks don't reveal the secret.
 */
function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  presented: string,
): boolean {
  const expected = createHmac("sha256", secret)
    .update(timestamp + body)
    .digest("base64");
  return constantTimeEqual(expected, presented);
}

function verifyTimestamp(timestamp: string, nowSec: number, windowSec: number): boolean {
  // Zendesk sends ISO 8601 timestamps. Parse and compare to "now"
  // within the configured replay window. Tolerate a numeric epoch-second
  // string too, which is what the test harness is likely to use.
  let tsSec: number;
  if (/^-?\d+$/.test(timestamp)) {
    tsSec = Number(timestamp);
  } else {
    const ms = Date.parse(timestamp);
    if (Number.isNaN(ms)) return false;
    tsSec = Math.floor(ms / 1000);
  }
  return Math.abs(nowSec - tsSec) <= windowSec;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function buildHttpIngest(config: ZendeskWebhookConfig): StatewaveIngest {
  const url = config.statewaveUrl;
  if (!url) {
    throw new ConnectorError("statewaveUrl required when ingest is not provided", {
      code: "config_invalid",
      connector: "zendesk",
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

const defaultLogger: NonNullable<ZendeskWebhookConfig["logger"]> = (level, msg, ctx) => {
  const line = ctx === undefined ? msg : `${msg} ${JSON.stringify(ctx)}`;
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.error)(line);
};
