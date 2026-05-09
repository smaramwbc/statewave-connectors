// Minimal Discord REST API client for the v0.1 pull-mode connector.
// We hit four endpoints — `GET /users/@me` (auth probe), `GET /guilds/{id}`
// (guild metadata), `GET /guilds/{id}/channels` (channel resolution), and
// `GET /channels/{id}/messages` (message pagination by snowflake). The
// connector does NOT use the realtime Gateway protocol; that's a separate
// daemon-shape effort similar to Slack's Socket Mode.

import { ConnectorError } from "@statewavedev/connectors-core";
import type { DiscordChannel, DiscordGuild, DiscordMessage, DiscordUser } from "./types.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DEFAULT_PAGE_LIMIT = 100;

export interface DiscordClientOptions {
  /** Bot token. Required — there is no useful unauthenticated mode. */
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface RawAuthResponse {
  id: string;
  username?: string;
  bot?: boolean;
}

interface RawGuildResponse {
  id: string;
  name?: string;
}

interface RawChannelResponse {
  id: string;
  name?: string;
  type?: number;
  parent_id?: string;
}

interface RawMessageResponse {
  id: string;
  type?: number;
  channel_id: string;
  author?: {
    id: string;
    username?: string;
    global_name?: string;
    bot?: boolean;
  };
  content?: string;
  timestamp: string;
  edited_timestamp?: string | null;
}

export class DiscordClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: DiscordClientOptions) {
    if (!options.token) {
      throw new ConnectorError("DISCORD_BOT_TOKEN is required for the discord connector", {
        code: "auth_missing",
        connector: "discord",
        hint: "create a Discord bot at https://discord.com/developers/applications, copy the Bot token, then export DISCORD_BOT_TOKEN=…",
      });
    }
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? DISCORD_API_BASE;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent =
      options.userAgent ??
      "DiscordBot (https://github.com/smaramwbc/statewave-connectors, 0.1.0)";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "discord",
      });
    }
  }

  /** Verify the token + return the bot's identity. */
  async authMe(): Promise<DiscordUser> {
    const r = await this.callJson<RawAuthResponse>(`/users/@me`);
    if (!r.id) {
      throw new ConnectorError("discord /users/@me returned no id", {
        code: "auth_failed",
        connector: "discord",
      });
    }
    return { id: r.id, username: r.username };
  }

  /** Resolve a guild's display name. Used to build a friendlier subject. */
  async getGuild(guildId: string): Promise<DiscordGuild> {
    const r = await this.callJson<RawGuildResponse>(`/guilds/${encodeURIComponent(guildId)}`);
    return { id: r.id, name: r.name };
  }

  /**
   * Resolve channel selectors against a guild's channel list. Selectors
   * may be IDs (snowflake) or names (`general` or `#general`). The bot
   * must already be in the guild for this to work — Discord's API doesn't
   * expose channels of guilds the bot can't see.
   */
  async resolveChannels(
    guildId: string,
    selectors: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<DiscordChannel>> {
    if (selectors.length === 0) return [];
    const channels = await this.callJson<ReadonlyArray<RawChannelResponse>>(
      `/guilds/${encodeURIComponent(guildId)}/channels`,
    );
    const byId = new Map(channels.map((c) => [c.id, c]));
    const byName = new Map<string, RawChannelResponse>();
    for (const c of channels) {
      if (c.name) byName.set(c.name, c);
    }

    const out: DiscordChannel[] = [];
    const missing: string[] = [];
    for (const sel of selectors) {
      const cleaned = sel.replace(/^#/, "");
      const direct = byId.get(cleaned);
      if (direct) {
        out.push({ id: direct.id, name: direct.name, type: direct.type, parent_id: direct.parent_id });
        continue;
      }
      const named = byName.get(cleaned);
      if (named) {
        out.push({ id: named.id, name: named.name, type: named.type, parent_id: named.parent_id });
        continue;
      }
      missing.push(sel);
    }
    if (missing.length > 0) {
      throw new ConnectorError(
        `discord: channels not found in guild ${guildId}: ${missing.join(", ")}`,
        {
          code: "not_found",
          connector: "discord",
          hint:
            "the bot must be invited to the guild AND have View Channel permission on the channels you want to ingest",
        },
      );
    }
    return out;
  }

  /**
   * Page through `GET /channels/{id}/messages` using snowflake-based
   * pagination (`before=<id>`). Discord returns messages newest-first;
   * we reverse the accumulated array so callers see chronological order.
   *
   * `since` filters by the message's ISO timestamp (Discord doesn't have a
   * native "since" param — the conventional approach is to convert your
   * cutoff to a snowflake via the unix-millis encoding, but that adds
   * complexity for marginal benefit at v0.1 volumes).
   */
  async listChannelMessages(
    channel: DiscordChannel,
    guild: DiscordGuild,
    options: { since?: string; maxItems?: number } = {},
  ): Promise<ReadonlyArray<DiscordMessage>> {
    const sinceMs = options.since ? new Date(options.since).getTime() : undefined;
    const cap = options.maxItems ?? Number.POSITIVE_INFINITY;
    const out: DiscordMessage[] = [];
    let before: string | undefined;

    while (out.length < cap) {
      const path = before
        ? `/channels/${encodeURIComponent(channel.id)}/messages?limit=${DEFAULT_PAGE_LIMIT}&before=${encodeURIComponent(before)}`
        : `/channels/${encodeURIComponent(channel.id)}/messages?limit=${DEFAULT_PAGE_LIMIT}`;
      const page = await this.callJson<ReadonlyArray<RawMessageResponse>>(path);
      if (page.length === 0) break;

      let stop = false;
      for (const m of page) {
        if (sinceMs !== undefined) {
          const tsMs = new Date(m.timestamp).getTime();
          if (Number.isFinite(tsMs) && tsMs < sinceMs) {
            stop = true;
            break;
          }
        }
        const adopted = adoptMessage(m, channel, guild);
        if (adopted) out.push(adopted);
        if (out.length >= cap) {
          stop = true;
          break;
        }
      }
      if (stop) break;

      // Page back further. Discord returns newest-first, so the oldest id
      // in this page is the cursor for the next call.
      const last = page[page.length - 1];
      if (!last) break;
      before = last.id;
      if (page.length < DEFAULT_PAGE_LIMIT) break;
    }

    return out.reverse();
  }

  // -- internals -----------------------------------------------------------

  private async callJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bot ${this.token}`,
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
    });

    if (res.status === 401) {
      throw new ConnectorError(`discord ${path} returned 401`, {
        code: "auth_failed",
        connector: "discord",
        hint: "verify DISCORD_BOT_TOKEN is valid and matches the bot in your application",
      });
    }
    if (res.status === 403) {
      throw new ConnectorError(`discord ${path} returned 403`, {
        code: "permission_denied",
        connector: "discord",
        hint:
          "the bot needs 'View Channel' + 'Read Message History' permissions on the target channels; for thread support also 'Read Threads'",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError(`discord ${path} rate-limited (HTTP 429)`, {
        code: "rate_limited",
        connector: "discord",
        hint: "Discord's per-route limits are tight; back off and retry",
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`discord ${path} returned HTTP ${res.status}`, {
        code: "network",
        connector: "discord",
      });
    }
    return (await res.json()) as T;
  }
}

/**
 * Translate the slice of a raw Discord message we care about into our typed
 * shape. Returns `null` for messages we deliberately skip — empty content
 * (embed-only messages), system messages (channel pins, member joins, …),
 * and bot-author messages where we don't have meaningful text.
 */
function adoptMessage(
  m: RawMessageResponse,
  channel: DiscordChannel,
  guild: DiscordGuild,
): DiscordMessage | null {
  // Skip system messages: types 1-12, 14-21 are member joins, pins,
  // boost notifications, etc. We only ingest user-authored chat (0) and
  // replies (19) for v0.1.
  const t = m.type ?? 0;
  if (t !== 0 && t !== 19) return null;
  if (!m.content || m.content.trim() === "") return null;
  if (!m.author) return null;

  return {
    type: "message",
    id: m.id,
    channel,
    guild,
    author: {
      id: m.author.id,
      username: m.author.username,
      global_name: m.author.global_name,
    },
    content: m.content,
    timestamp: m.timestamp,
    edited_timestamp: m.edited_timestamp ?? null,
    message_type: t,
  };
}
