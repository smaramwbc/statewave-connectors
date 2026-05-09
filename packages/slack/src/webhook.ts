// `createSlackWebhookHandler` — Slack Events-API receiver as a pure
// `(Request) => Promise<Response>`. Works on Vercel, Cloudflare Workers,
// Lambda, Express (via a tiny adapter), Node http (likewise), Hono, and
// anywhere else a fetch-style handler is acceptable.
//
// Lifecycle of a single Slack delivery:
//   1. Read raw body bytes (the signature is computed over the bytes,
//      not the JSON object).
//   2. HMAC-verify against the signing secret. Reject 401 if bad.
//   3. Parse JSON. If `type === "url_verification"`, echo `challenge`
//      and exit (this is how Slack confirms the URL during app setup).
//   4. Dedup by `event_id`. If already seen, ack 200 immediately.
//   5. Filter on the channel allowlist + the same subtype rules the
//      pull-mode connector uses (skip channel_join, leave, empty text).
//   6. Map → StatewaveEpisode → ingest. Errors are logged but the
//      response is still 200 so Slack stops retrying — the dedup cache
//      ensures we don't reprocess the same event later.
//
// Slack expects a 200 within 3s. The handler does the ingest call inline,
// which is fast enough in practice (<500ms for a single episode against a
// nearby Statewave instance). Callers who run on serverless platforms with
// `waitUntil` semantics can shape their wrapper to fire-and-forget if they
// have stricter latency budgets — the handler is itself synchronous-shaped
// and won't be hurt.

import { ConnectorError, type StatewaveEpisode } from "@statewavedev/connectors-core";
import { defaultSubject, mapSlackEvent } from "./mapper.js";
import type { SlackChannelRef, SlackMessage, SlackUser, SlackWorkspace } from "./types.js";
import { verifySlackSignature } from "./webhook-signature.js";
import {
  InMemoryDedupCache,
  type SlackDedupCache,
} from "./webhook-dedup.js";
import {
  createDefaultIngest,
  type StatewaveIngest,
} from "./webhook-ingest.js";
import type {
  SlackEventCallback,
  SlackInboundEvent,
  SlackUrlVerification,
  SlackWebhookPayload,
} from "./webhook-types.js";

export interface SlackWebhookConfig {
  /** Slack signing secret (Settings → Basic Information → App-Level
   * Signing Secret). Used for HMAC verification of every request. */
  signingSecret: string;
  /**
   * Channel allowlist — channel IDs (`C…`) that the webhook will ingest
   * for. Same shape as the pull-mode connector except we don't resolve
   * names because Slack only delivers IDs. Pass an empty array to disable
   * filtering (NOT recommended in production).
   */
  channels: ReadonlyArray<string>;
  /** Workspace id (`T…`) used to build the default subject. The
   * connector reads it off the inbound event when not supplied. */
  workspace?: SlackWorkspace;
  /** Override the default `team:<team_id>` subject. */
  subject?: string;
  /** Where to ship the resulting episode. Required unless `ingest` is provided. */
  statewaveUrl?: string;
  statewaveApiKey?: string;
  statewaveTenantId?: string;
  /** Custom ingest sink — overrides the built-in HTTP one. Useful for
   * batching, alternate auth, or testing. */
  ingest?: StatewaveIngest;
  /** Replace the default in-memory dedup cache (e.g. with a Redis-backed
   * one for cross-process deployments). */
  dedupCache?: SlackDedupCache;
  /** Logger sink — defaults to console.error. Wire to your platform's
   * structured logger to keep the response path clean. */
  logger?: (level: "info" | "warn" | "error", msg: string, ctx?: unknown) => void;
  /** Override the wall clock for signature freshness checks (tests). */
  now?: () => number;
  /** Inject `fetch` for tests + non-Node runtimes that don't expose it
   * globally (older Node versions, some sandboxes). */
  fetchImpl?: typeof fetch;
}

export interface SlackWebhookHandler {
  (req: Request): Promise<Response>;
  /** Exposed so callers can plug the same dedup cache into multiple
   * handler instances (e.g. one per channel). */
  readonly dedupCache: SlackDedupCache;
}

export function createSlackWebhookHandler(config: SlackWebhookConfig): SlackWebhookHandler {
  if (!config.signingSecret) {
    throw new ConnectorError(
      "createSlackWebhookHandler requires signingSecret (Slack signing secret)",
      { code: "config_invalid", connector: "slack" },
    );
  }
  if (!config.ingest && !config.statewaveUrl) {
    throw new ConnectorError(
      "createSlackWebhookHandler requires either statewaveUrl or a custom ingest function",
      { code: "config_invalid", connector: "slack" },
    );
  }

  const ingest =
    config.ingest ??
    createDefaultIngest({
      url: config.statewaveUrl!,
      apiKey: config.statewaveApiKey,
      tenantId: config.statewaveTenantId,
      fetchImpl: config.fetchImpl,
    });
  const dedupCache = config.dedupCache ?? new InMemoryDedupCache();
  const logger = config.logger ?? defaultLogger;
  const allowChannels = new Set(config.channels);

  const handler = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      // Slack only POSTs; anything else is probably a probe.
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return jsonResponse({ error: "body_read_failed" }, 400);
    }

    const verify = verifySlackSignature({
      signingSecret: config.signingSecret,
      rawBody,
      signatureHeader: req.headers.get("x-slack-signature"),
      timestampHeader: req.headers.get("x-slack-request-timestamp"),
      now: config.now,
    });
    if (!verify.ok) {
      logger("warn", "slack-webhook: signature rejected", { reason: verify.reason });
      return jsonResponse({ error: verify.reason }, 401);
    }

    let payload: SlackWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as SlackWebhookPayload;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    if (payload.type === "url_verification") {
      return handleUrlVerification(payload);
    }
    if (payload.type !== "event_callback") {
      // app_rate_limited, app_uninstalled, … — ack 200 so Slack stops retrying.
      logger("info", "slack-webhook: unhandled top-level type", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: (payload as any).type,
      });
      return jsonResponse({ ok: true, ignored: "unhandled_type" }, 200);
    }

    if (!payload.event_id) {
      logger("warn", "slack-webhook: event_callback missing event_id", { team: payload.team_id });
      return jsonResponse({ ok: true, ignored: "no_event_id" }, 200);
    }
    const seen = await dedupCache.seenOrMark(payload.event_id);
    if (seen) {
      logger("info", "slack-webhook: duplicate event suppressed", {
        event_id: payload.event_id,
      });
      return jsonResponse({ ok: true, deduplicated: true }, 200);
    }

    const ev = payload.event;
    if (!shouldIngest(ev, allowChannels)) {
      return jsonResponse({ ok: true, ignored: "filtered" }, 200);
    }

    try {
      const episode = mapInboundEvent(ev, payload.team_id, config);
      if (episode) await ingest(episode);
    } catch (err) {
      // Log but still ack — re-running through Slack's retry would just
      // re-fail. The dedup cache means we don't reprocess.
      logger("error", "slack-webhook: ingest failed", {
        event_id: payload.event_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse({ ok: true }, 200);
  };

  // Wrap the handler to expose dedupCache as a readonly property.
  return Object.assign(handler, { dedupCache }) as SlackWebhookHandler;
}

// -- internals -------------------------------------------------------------

function handleUrlVerification(payload: SlackUrlVerification): Response {
  // Slack expects a `challenge` echo within 3s during URL setup.
  return new Response(JSON.stringify({ challenge: payload.challenge }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Decide whether a given inbound event is something we want to ingest.
 * Mirrors the same skip rules as the pull-mode connector's `adoptMessage`
 * helper — channel_join / channel_leave subtypes, empty text, and bot
 * meta-events all fall on the floor.
 */
function shouldIngest(
  ev: SlackInboundEvent,
  allowChannels: Set<string>,
): boolean {
  if (ev.type !== "message") return false;
  if (ev.subtype === "channel_join" || ev.subtype === "channel_leave") return false;
  if (!ev.text || ev.text.trim() === "") return false;
  if (allowChannels.size > 0 && !allowChannels.has(ev.channel)) return false;
  return true;
}

/**
 * Translate the inbound webhook event into the same `SlackMessage` shape
 * the pull-mode mapper consumes, then run it through `mapSlackEvent`. This
 * keeps the episode shape identical between live and pull modes — same
 * kinds, same subject defaults, same idempotency keys.
 */
function mapInboundEvent(
  ev: SlackInboundEvent,
  teamId: string,
  config: SlackWebhookConfig,
): StatewaveEpisode | null {
  const channel: SlackChannelRef = { id: ev.channel };
  const user: SlackUser | null = ev.user ? { id: ev.user } : null;
  const message: SlackMessage = {
    type: "message",
    ts: ev.ts,
    thread_ts: ev.thread_ts ?? ev.ts,
    channel,
    user,
    bot_id: ev.bot_id ?? null,
    text: ev.text ?? "",
  };
  const workspace: SlackWorkspace = config.workspace ?? { team_id: teamId };
  const subject = config.subject ?? defaultSubject(workspace);
  return mapSlackEvent(message, { workspace, subject });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const defaultLogger: NonNullable<SlackWebhookConfig["logger"]> = (level, msg, ctx) => {
  // Stays on stderr so it never collides with a structured response body.
  const line = ctx === undefined ? msg : `${msg} ${JSON.stringify(ctx)}`;
  if (level === "error") console.error(`[slack-webhook] ${line}`);
  else if (level === "warn") console.warn(`[slack-webhook] ${line}`);
  else console.log(`[slack-webhook] ${line}`);
};
