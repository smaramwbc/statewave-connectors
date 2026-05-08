// Minimal Slack Web API client for the v0.1 pull-mode connector. We only
// touch four endpoints — `auth.test`, `conversations.list`,
// `conversations.history`, and `conversations.replies` (plus an optional
// `users.info` per author for display-name resolution) — and we go through
// `fetch` directly to keep the dependency footprint at zero. Slack's official
// SDK is excellent but pulls in 30+ transitive packages and we don't need
// the realtime/socket-mode pieces yet.

import { ConnectorError } from "@statewavedev/connectors-core";
import type { SlackChannelRef, SlackMessage, SlackUser, SlackWorkspace } from "./types.js";

const SLACK_API_BASE = "https://slack.com/api";
const DEFAULT_PAGE_LIMIT = 200;

export interface SlackClientOptions {
  /** Bot token (`xoxb-…`). Required — there is no useful unauthenticated mode. */
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Floor for the rate-limit retry sleep, in milliseconds (defaults to 1s). */
  minRetryMs?: number;
  /** Hard cap on the rate-limit retry sleep, in milliseconds (defaults to 60s). */
  maxRetryMs?: number;
}

/** A single page of `conversations.history` or `conversations.replies`. */
interface SlackHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: ReadonlyArray<RawMessage>;
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface SlackChannelsResponse {
  ok: boolean;
  error?: string;
  channels?: ReadonlyArray<{ id: string; name?: string; is_private?: boolean }>;
  response_metadata?: { next_cursor?: string };
}

interface SlackAuthTestResponse {
  ok: boolean;
  error?: string;
  team_id?: string;
  team?: string;
  user_id?: string;
}

interface SlackUsersInfoResponse {
  ok: boolean;
  error?: string;
  user?: { id: string; name?: string; real_name?: string };
}

/**
 * Raw Slack message envelope. Slack's API returns more fields than this — we
 * type only the ones the v0.1 connector consumes; unknown fields just fall on
 * the floor.
 */
interface RawMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
}

export class SlackClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minRetryMs: number;
  private readonly maxRetryMs: number;

  constructor(options: SlackClientOptions) {
    if (!options.token) {
      throw new ConnectorError("SLACK_BOT_TOKEN is required for the slack connector", {
        code: "config_invalid",
        connector: "slack",
        hint: "set SLACK_BOT_TOKEN to a bot token (xoxb-…) with channels:history + channels:read scopes",
      });
    }
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? SLACK_API_BASE;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.minRetryMs = options.minRetryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 60_000;
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "slack",
      });
    }
  }

  /** Verify the token and resolve the workspace identity. */
  async authTest(): Promise<SlackWorkspace> {
    const r = await this.callJson<SlackAuthTestResponse>("auth.test", {});
    if (!r.team_id) {
      throw new ConnectorError("auth.test returned no team_id", {
        code: "network",
        connector: "slack",
      });
    }
    return { team_id: r.team_id, team_name: r.team };
  }

  /**
   * Resolve channel name → id (Slack's history endpoints take ids only). The
   * caller passes channel selectors that may be either ids (`C…`) or names; we
   * page through `conversations.list` once and build a name→id map.
   */
  async resolveChannels(
    selectors: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<SlackChannelRef>> {
    const idLike = selectors.filter((s) => /^[CG][A-Z0-9]+$/.test(s));
    const nameLike = selectors.filter((s) => !idLike.includes(s));
    const resolved: SlackChannelRef[] = idLike.map((id) => ({ id }));
    if (nameLike.length === 0) return resolved;

    const wanted = new Set(nameLike.map((n) => n.replace(/^#/, "")));
    let cursor: string | undefined;
    do {
      const params: Record<string, string> = {
        limit: String(DEFAULT_PAGE_LIMIT),
        types: "public_channel,private_channel",
      };
      if (cursor) params.cursor = cursor;
      const r = await this.callJson<SlackChannelsResponse>("conversations.list", params);
      for (const c of r.channels ?? []) {
        if (c.name && wanted.has(c.name)) {
          resolved.push({ id: c.id, name: c.name, is_private: c.is_private });
          wanted.delete(c.name);
        }
      }
      cursor = r.response_metadata?.next_cursor || undefined;
      if (wanted.size === 0) break;
    } while (cursor);

    if (wanted.size > 0) {
      throw new ConnectorError(
        `slack: channels not found in workspace: ${[...wanted].join(", ")}`,
        {
          code: "not_found",
          connector: "slack",
          hint: "the bot must be invited to private channels before they appear in conversations.list",
        },
      );
    }
    return resolved;
  }

  /**
   * Pull top-level channel messages, paging through `conversations.history`
   * until exhausted (or `oldest` is reached). Returns messages in ascending
   * timestamp order so callers can stream into batch-ingest without resorting.
   */
  async listChannelMessages(
    channel: SlackChannelRef,
    options: { since?: string } = {},
  ): Promise<ReadonlyArray<SlackMessage>> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, string> = {
        channel: channel.id,
        limit: String(DEFAULT_PAGE_LIMIT),
      };
      if (options.since) params.oldest = sinceToTs(options.since);
      if (cursor) params.cursor = cursor;
      const r = await this.callJson<SlackHistoryResponse>("conversations.history", params);
      for (const m of r.messages ?? []) {
        const mapped = adoptMessage(m, channel);
        if (mapped) out.push(mapped);
      }
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // Slack returns messages newest-first. Reverse so consumers see history
    // in chronological order — this matches the rest of the connector
    // ecosystem and makes incremental ingestion deterministic.
    return out.reverse();
  }

  /**
   * Pull thread replies for a parent message. Slack returns the parent itself
   * as the first item; we drop it so callers don't double-count the top-level
   * message they've already ingested via `listChannelMessages`.
   */
  async listThreadReplies(
    channel: SlackChannelRef,
    threadTs: string,
  ): Promise<ReadonlyArray<SlackMessage>> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, string> = {
        channel: channel.id,
        ts: threadTs,
        limit: String(DEFAULT_PAGE_LIMIT),
      };
      if (cursor) params.cursor = cursor;
      const r = await this.callJson<SlackHistoryResponse>("conversations.replies", params);
      for (const m of r.messages ?? []) {
        if (m.ts === threadTs) continue;
        const mapped = adoptMessage(m, channel);
        if (mapped) out.push(mapped);
      }
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  /** Look up a user record. Returns `null` if the lookup fails — display
   * names are nice-to-have, never required for ingestion. */
  async lookupUser(userId: string): Promise<SlackUser | null> {
    try {
      const r = await this.callJson<SlackUsersInfoResponse>("users.info", { user: userId });
      if (!r.user) return null;
      return { id: r.user.id, name: r.user.name, real_name: r.user.real_name };
    } catch {
      return null;
    }
  }

  // -- internals -----------------------------------------------------------

  private async callJson<T extends { ok: boolean; error?: string }>(
    method: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}/${method}`;
    const body = new URLSearchParams(params).toString();

    // Slack's rate-limit response carries a Retry-After header; honor it once
    // before giving up. We do not implement an arbitrary-depth retry loop —
    // a stuck connector should surface to the operator quickly, not silently
    // retry forever.
    let attempt = 0;
    while (attempt < 2) {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          Accept: "application/json",
        },
        body,
      });
      if (res.status === 429 && attempt === 0) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterSec = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : 1;
        const sleepMs = Math.min(
          this.maxRetryMs,
          Math.max(this.minRetryMs, (Number.isFinite(retryAfterSec) ? retryAfterSec : 1) * 1000),
        );
        await new Promise((r) => setTimeout(r, sleepMs));
        attempt += 1;
        continue;
      }
      if (!res.ok) {
        throw new ConnectorError(`slack ${method} returned HTTP ${res.status}`, {
          code: "network",
          connector: "slack",
        });
      }
      const json = (await res.json()) as T;
      if (!json.ok) {
        throw new ConnectorError(
          `slack ${method} returned ok=false: ${json.error ?? "unknown_error"}`,
          {
            code: json.error === "missing_scope" ? "config_invalid" : "network",
            connector: "slack",
            hint:
              json.error === "missing_scope"
                ? "the bot token needs channels:history, channels:read, groups:history, groups:read"
                : undefined,
          },
        );
      }
      return json;
    }
    throw new ConnectorError(`slack ${method} rate-limited; aborted after one retry`, {
      code: "rate_limited",
      connector: "slack",
    });
  }
}

/**
 * Translate the slice of a raw Slack message we care about into our typed
 * shape. Returns `null` for messages we deliberately skip — channel join/leave
 * notices, file_share subtypes without text, etc. — keeping the v0.1 ingest
 * focused on actual conversational content.
 */
function adoptMessage(m: RawMessage, channel: SlackChannelRef): SlackMessage | null {
  if (m.type !== "message") return null;
  if (m.subtype === "channel_join" || m.subtype === "channel_leave") return null;
  if (!m.text || m.text.trim() === "") return null;

  const user: SlackUser | null = m.user ? { id: m.user } : null;
  return {
    type: "message",
    ts: m.ts,
    thread_ts: m.thread_ts ?? m.ts,
    channel,
    user,
    bot_id: m.bot_id ?? null,
    text: m.text,
    reply_count: m.reply_count,
  };
}

/**
 * Convert a `--since` value (ISO-8601 or `YYYY-MM-DD`) to Slack's
 * fractional-second epoch string. Slack's API accepts strings like
 * `1700000000.000000`, but it tolerates plain `1700000000` so we keep the
 * extra precision optional.
 */
function sinceToTs(since: string): string {
  const ms = new Date(since).getTime();
  if (!Number.isFinite(ms)) {
    throw new ConnectorError(`invalid --since value for slack: ${since}`, {
      code: "config_invalid",
      connector: "slack",
      hint: "use ISO-8601 (e.g. 2025-01-01) or a unix timestamp",
    });
  }
  return (ms / 1000).toFixed(6);
}
