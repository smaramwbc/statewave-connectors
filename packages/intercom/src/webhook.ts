// `createIntercomWebhookHandler` — Intercom webhook receiver. Same pure
// `(Request) => Promise<Response>` shape as the Slack/Freshdesk/Zendesk
// receivers. Verifies Intercom's HMAC-SHA1 signature, dedups retries by
// the envelope `id`, maps the inbound payload into the existing
// `mapIntercomEvent` mapper, and ingests the result.
//
// Auth model: Intercom signs the raw body with HMAC-SHA1 using the
// app's "Client Secret" (Settings → Integrations → Developer Hub → your
// app → Authentication → Client secret). The signature is presented as
// `X-Hub-Signature: sha1=<hexdigest>`. Intercom does NOT include a
// timestamp, so there is no replay-window check — dedup by envelope id
// is the protection against repeated deliveries.
//
// Topics dispatched:
//   conversation.user.created   → intercom.conversation.created
//   conversation.user.replied   → intercom.conversation.replied (latest part)
//   conversation.admin.replied  → intercom.conversation.replied (latest part)
//   conversation.admin.noted    → intercom.conversation.note_added (latest part)
//   conversation.admin.closed   → intercom.conversation.closed
//
// Other topics are ack'd with `ignored: "unknown_topic"` so the operator
// can subscribe broadly in Intercom without 4xx-ing the firehose.

import { createHmac } from "node:crypto";
import { ConnectorError, type StatewaveEpisode } from "@statewavedev/connectors-core";
import { mapIntercomEvent } from "./mapper.js";
import type {
  IntercomContact,
  IntercomConversation,
  IntercomConversationPart,
  IntercomConversationState,
  IntercomEvent,
  IntercomRegion,
} from "./types.js";
import {
  type IntercomDedupCache,
  InMemoryIntercomDedupCache,
} from "./webhook-dedup.js";
import type {
  IntercomWebhookConversation,
  IntercomWebhookConversationPart,
  IntercomWebhookEvent,
} from "./webhook-types.js";

const DEFAULT_SIGNATURE_HEADER = "x-hub-signature";

/** Shape of the ingest sink. Same contract as the other receivers. */
export type StatewaveIngest = (episode: StatewaveEpisode) => Promise<void>;

export interface IntercomWebhookConfig {
  /**
   * Intercom app's Client Secret (Settings → Integrations → Developer
   * Hub → your app → Authentication → Client secret). Required.
   */
  signingSecret: string;
  /**
   * Workspace (app) id — used to mint browser permalinks like
   * `https://app.intercom.com/a/inbox/<app_id>/inbox/conversation/<id>`
   * on emitted episodes. Optional; if omitted, episodes carry no
   * permalink.
   */
  appId?: string;
  /** Region — picks the right `app.<region>.intercom.com` host. Default `us`. */
  region?: IntercomRegion;
  /** Override subject. Defaults to `customer:<company_or_contact_id>` per conversation. */
  subject?: string;
  /** Where to ship the resulting episode. Required unless `ingest` is provided. */
  statewaveUrl?: string;
  statewaveApiKey?: string;
  statewaveTenantId?: string;
  /** Custom ingest sink — overrides the built-in HTTP one. */
  ingest?: StatewaveIngest;
  /** Replace the default in-memory dedup cache. */
  dedupCache?: IntercomDedupCache;
  /** Logger sink — defaults to console.error. */
  logger?: (level: "info" | "warn" | "error", msg: string, ctx?: unknown) => void;
  /** Inject `fetch` for tests + non-Node runtimes. */
  fetchImpl?: typeof fetch;
  /** Override the signature header name (default `x-hub-signature`). */
  signatureHeader?: string;
}

export interface IntercomWebhookHandler {
  (req: Request): Promise<Response>;
  readonly dedupCache: IntercomDedupCache;
}

export function createIntercomWebhookHandler(
  config: IntercomWebhookConfig,
): IntercomWebhookHandler {
  if (!config.signingSecret) {
    throw new ConnectorError(
      "createIntercomWebhookHandler requires signingSecret (Intercom app Client Secret)",
      { code: "config_invalid", connector: "intercom" },
    );
  }
  if (!config.ingest && !config.statewaveUrl) {
    throw new ConnectorError(
      "createIntercomWebhookHandler requires statewaveUrl or a custom ingest sink",
      { code: "config_invalid", connector: "intercom" },
    );
  }

  const dedupCache = config.dedupCache ?? new InMemoryIntercomDedupCache();
  const signatureHeader = (config.signatureHeader ?? DEFAULT_SIGNATURE_HEADER).toLowerCase();
  const ingest = config.ingest ?? buildHttpIngest(config);
  const logger = config.logger ?? defaultLogger;

  const handler = (async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    const signature = req.headers.get(signatureHeader);
    if (!signature) {
      return jsonResponse({ error: "missing_signature" }, 401);
    }

    let body: string;
    try {
      body = await req.text();
    } catch (err) {
      logger("warn", "intercom webhook body read failed", { err: String(err) });
      return jsonResponse({ error: "body_read_failed" }, 400);
    }

    if (!verifySignature(config.signingSecret, body, signature)) {
      return jsonResponse({ error: "bad_signature" }, 401);
    }

    let envelope: IntercomWebhookEvent;
    try {
      envelope = JSON.parse(body) as IntercomWebhookEvent;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    if (!envelope.id || !envelope.topic) {
      return jsonResponse({ ok: true, ignored: "missing_envelope_fields" }, 200);
    }

    const seen = await dedupCache.seenOrMark(envelope.id);
    if (seen) {
      return jsonResponse({ ok: true, deduplicated: true }, 200);
    }

    const dispatched = mapInboundEvent(envelope);
    if (!dispatched) {
      return jsonResponse({ ok: true, ignored: dispatched === null ? "unknown_topic" : "missing_conversation" }, 200);
    }

    const episode = mapIntercomEvent(dispatched, {
      subject: config.subject,
      appId: config.appId,
      region: config.region,
    });

    try {
      await ingest(episode);
    } catch (err) {
      // Always 200 on ingest failure — Intercom would retry on non-2xx
      // and the next attempt rejoins our dedup window. Operators see
      // ingest failures via the logger sink.
      logger("error", "intercom webhook ingest failed", {
        topic: envelope.topic,
        envelope_id: envelope.id,
        err: String(err),
      });
    }

    return jsonResponse({ ok: true, ingested: true }, 200);
  }) as IntercomWebhookHandler;
  Object.defineProperty(handler, "dedupCache", { value: dedupCache, enumerable: true });
  return handler;
}

/**
 * Translate the inbound Intercom envelope into an `IntercomEvent` the
 * shared mapper consumes. Returns null for unrecognised topics so the
 * caller can ack-and-skip rather than 4xx-ing on benign topics the
 * operator subscribed to but the receiver doesn't model yet.
 */
function mapInboundEvent(envelope: IntercomWebhookEvent): IntercomEvent | null {
  const item = envelope.data?.item as IntercomWebhookConversation | undefined;
  if (!item || item.type !== "conversation" || !item.id) return null;

  const conversation = adoptConversation(item);

  switch (envelope.topic) {
    case "conversation.user.created":
      return { type: "conversation.created", conversation };
    case "conversation.admin.closed":
      return {
        type: "conversation.closed",
        conversation: { ...conversation, state: "closed" },
      };
    case "conversation.user.replied":
    case "conversation.admin.replied":
    case "conversation.admin.noted": {
      const part = pickLatestPart(item, envelope.topic);
      if (!part) return null;
      return { type: "conversation.part", conversation, part };
    }
    default:
      return null;
  }
}

function pickLatestPart(
  item: IntercomWebhookConversation,
  topic: string,
): IntercomConversationPart | undefined {
  const parts = item.conversation_parts?.conversation_parts ?? [];
  if (parts.length === 0) return undefined;
  // For replies/notes we want the most recent part of the matching
  // shape (`comment` for replies, `note` for noted). Walk from the end
  // so the newest qualifying part wins.
  const wantedType = topic === "conversation.admin.noted" ? "note" : "comment";
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const candidate = parts[i];
    if (!candidate) continue;
    if (candidate.part_type === wantedType) {
      return adoptPart(candidate);
    }
  }
  // Fallback: the most recent part of any shape, so we still emit
  // *something* rather than swallowing the event silently.
  const lastPart = parts[parts.length - 1];
  return lastPart ? adoptPart(lastPart) : undefined;
}

function adoptConversation(item: IntercomWebhookConversation): IntercomConversation {
  const contact = adoptContact(item);
  const tags = adoptTags(item.tags);
  const state = adoptState(item.state);
  const out: IntercomConversation = {
    id: item.id,
    created_at: epochToIso(item.created_at),
    updated_at: epochToIso(item.updated_at),
    state,
    tags,
    source_body: item.source?.body ?? "",
    source_subject: item.source?.subject ?? null,
    assignee_admin_id:
      item.assignee?.type === "admin" ? item.assignee.id ?? null : null,
    team_assignee_id: item.team_assignee_id ?? null,
  };
  if (contact) out.contact = contact;
  if (item.priority === "priority" || item.priority === "not_priority") {
    out.priority = item.priority;
  }
  return out;
}

function adoptContact(item: IntercomWebhookConversation): IntercomContact | undefined {
  const c = item.contacts?.contacts?.[0];
  if (!c?.id) return undefined;
  const out: IntercomContact = { id: c.id };
  if (c.name) out.name = c.name;
  if (c.email) out.email = c.email;
  if (c.external_id) out.external_id = c.external_id;
  if (c.role) out.role = c.role;
  return out;
}

function adoptTags(
  raw: IntercomWebhookConversation["tags"],
): ReadonlyArray<string> {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const tags = (raw as { tags?: ReadonlyArray<{ name?: string }> }).tags ?? [];
  return tags
    .map((t) => t.name)
    .filter((n): n is string => typeof n === "string");
}

function adoptState(raw: string | undefined): IntercomConversationState {
  if (raw === "open" || raw === "closed" || raw === "snoozed") return raw;
  return "open";
}

function adoptPart(p: IntercomWebhookConversationPart): IntercomConversationPart {
  const out: IntercomConversationPart = {
    id: p.id,
    part_type: p.part_type,
    created_at: epochToIso(p.created_at),
  };
  if (p.body !== undefined && p.body !== null) out.body = p.body;
  if (p.author?.type) out.author_type = p.author.type;
  if (p.author?.id !== undefined) out.author_id = p.author.id ?? null;
  if (p.author?.name !== undefined) out.author_name = p.author.name ?? null;
  return out;
}

function epochToIso(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return new Date(0).toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

/**
 * Verify Intercom's `X-Hub-Signature: sha1=<hex>` MAC. Intercom signs
 * the raw body (no timestamp prefix). Constant-time compare so timing
 * leaks don't reveal the secret.
 */
function verifySignature(secret: string, body: string, presented: string): boolean {
  const expected = `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;
  return constantTimeEqual(expected, presented);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function buildHttpIngest(config: IntercomWebhookConfig): StatewaveIngest {
  const url = config.statewaveUrl;
  if (!url) {
    throw new ConnectorError("statewaveUrl required when ingest is not provided", {
      code: "config_invalid",
      connector: "intercom",
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

const defaultLogger: NonNullable<IntercomWebhookConfig["logger"]> = (level, msg, ctx) => {
  const line = ctx === undefined ? msg : `${msg} ${JSON.stringify(ctx)}`;
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.error)(line);
};
