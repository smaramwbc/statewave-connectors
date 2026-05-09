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
import {
  defaultSubject,
  mapSlackEvent,
  mapSlackPinEvent,
  mapSlackReactionEvent,
} from "./mapper.js";
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
  SlackInboundMessage,
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
   * filtering (NOT recommended in production). The allowlist applies to
   * public/private channel events; DM (`im`) and group-DM (`mpim`) events
   * bypass it because the channel id is a synthetic D…/G… snowflake the
   * operator can't predict. They're gated by `acceptDms` / `acceptMpim`.
   */
  channels: ReadonlyArray<string>;
  /**
   * Accept inbound DM messages — events with `channel_type: "im"` (v0.4.0).
   * When true, the webhook dispatches every DM the bot is a participant
   * in to `slack.dm.message.posted` / `slack.dm.thread.replied` on
   * `dm:<other_user_id>` subjects (same shape pull-mode `--include-dms`
   * uses). When false (the default), DM events the Slack app subscribes
   * to via `message.im` are filtered out with `filter_reason:dms_disabled`.
   * Same privacy disclaimer as pull-mode DMs — opt-in deliberately.
   */
  acceptDms?: boolean;
  /**
   * Accept inbound multi-party DM messages — events with
   * `channel_type: "mpim"` (v0.4.0). When true, group DMs the bot is a
   * member of dispatch to `slack.mpim.message.posted` /
   * `slack.mpim.thread.replied` on `mpim:<channel_id>` subjects. When
   * false, mpim events are filtered out.
   */
  acceptMpim?: boolean;
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
    const filterReason = filterReasonForEvent(ev, allowChannels, {
      acceptDms: !!config.acceptDms,
      acceptMpim: !!config.acceptMpim,
    });
    if (filterReason) {
      return jsonResponse({ ok: true, ignored: filterReason }, 200);
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
 * Decide whether to ingest the event. Returns a string describing the
 * skip reason (so we can include it in the response body for debugging),
 * or `null` if the event should proceed. Messages get the same filter the
 * pull-mode connector applies (channel_join / channel_leave / empty text);
 * reactions and pins use minimal filters (allowlist + has-required-fields).
 */
function filterReasonForEvent(
  ev: SlackInboundEvent,
  allowChannels: Set<string>,
  options: { acceptDms: boolean; acceptMpim: boolean },
): string | null {
  if (ev.type === "message") {
    if (ev.subtype === "channel_join" || ev.subtype === "channel_leave") return "subtype_skipped";
    if (!ev.text || ev.text.trim() === "") return "empty_text";
    // DM and MPIM messages bypass the channel allowlist (channel ids
    // are synthetic D…/G… snowflakes operators can't predict ahead of
    // time) and are gated instead by the explicit accept-* flags.
    if (ev.channel_type === "im") {
      return options.acceptDms ? null : "dms_disabled";
    }
    if (ev.channel_type === "mpim") {
      return options.acceptMpim ? null : "mpim_disabled";
    }
    if (allowChannels.size > 0 && !allowChannels.has(ev.channel)) return "channel_not_allowed";
    return null;
  }
  if (ev.type === "reaction_added" || ev.type === "reaction_removed") {
    if (ev.item.type !== "message") return "non_message_item";
    if (allowChannels.size > 0 && !allowChannels.has(ev.item.channel)) return "channel_not_allowed";
    return null;
  }
  if (ev.type === "pin_added" || ev.type === "pin_removed") {
    if (ev.item.type !== "message") return "non_message_item";
    if (allowChannels.size > 0 && !allowChannels.has(ev.channel_id)) return "channel_not_allowed";
    return null;
  }
  return "unknown_event_type";
}

/**
 * Translate the inbound webhook event into a Statewave episode. Messages
 * flow through `mapSlackEvent` (shared with pull mode); reactions and
 * pins use dedicated mappers.
 */
function mapInboundEvent(
  ev: SlackInboundEvent,
  teamId: string,
  config: SlackWebhookConfig,
): StatewaveEpisode | null {
  const workspace: SlackWorkspace = config.workspace ?? { team_id: teamId };
  const subject = config.subject ?? defaultSubject(workspace);

  if (ev.type === "message") {
    return mapMessageInbound(ev, workspace, subject, config);
  }
  if (ev.type === "reaction_added" || ev.type === "reaction_removed") {
    return mapSlackReactionEvent(ev, { workspace, subject });
  }
  if (ev.type === "pin_added" || ev.type === "pin_removed") {
    return mapSlackPinEvent(ev, { workspace, subject });
  }
  return null;
}

function mapMessageInbound(
  ev: SlackInboundMessage,
  workspace: SlackWorkspace,
  subject: string,
  config: SlackWebhookConfig,
): StatewaveEpisode {
  // v0.4.0: stamp DM/MPIM flags on the channel ref so the shared
  // `mapSlackEvent` mapper picks the right kind (slack.dm.* / slack.mpim.*)
  // and per-event subject (dm:<user> / mpim:<channel>). For DMs, Slack
  // delivers the OTHER user's id as `ev.user` (the bot doesn't see its
  // own messages echoed back), so it doubles as the dm_user_id anchor.
  const channel: SlackChannelRef = ev.channel_type === "im"
    ? { id: ev.channel, is_im: true, dm_user_id: ev.user }
    : ev.channel_type === "mpim"
      ? { id: ev.channel, is_mpim: true }
      : { id: ev.channel };
  // For DM/MPIM, override the workspace-wide subject with the per-event
  // anchor unless the operator passed an explicit override on config.subject.
  const perEventSubject =
    config.subject
      ? config.subject
      : channel.is_im && channel.dm_user_id
        ? `dm:${channel.dm_user_id}`
        : channel.is_mpim
          ? `mpim:${channel.id}`
          : subject;
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
  return mapSlackEvent(message, { workspace, subject: perEventSubject });
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
