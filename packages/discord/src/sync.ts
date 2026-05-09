// `createDiscordConnector` — pull-mode source connector for Discord.
// Reads channel messages from a single guild via the Discord REST API
// and emits `discord.message.posted` / `discord.thread.replied` episodes.

import {
  ConnectorError,
  redactEpisodeText,
  summarizeEpisodes,
  type ConnectorCheckResult,
  type StatewaveConnector,
  type StatewaveEpisode,
  type SyncOptions,
  type SyncResult,
} from "@statewavedev/connectors-core";
import { DiscordClient, type DiscordClientOptions } from "./client.js";
import { defaultSubject, mapDiscordEvent } from "./mapper.js";
import type { DiscordChannel, DiscordEvent, DiscordGuild, DiscordMessage } from "./types.js";

export interface DiscordConnectorConfig {
  /** Bot token (required). Auth + REST calls go through this. */
  token: string;
  /** Guild (server) id to scope ingestion to. Required because a bot may
   * belong to multiple guilds and ingesting all of them would be expensive
   * + surprising. */
  guildId: string;
  /**
   * Channel selectors — either IDs (snowflakes) or names (`general` /
   * `#general`). At least one is required so first-run never walks the
   * entire guild.
   */
  channels: ReadonlyArray<string>;
  /** Override subject. Defaults to `community:<guild_id>`. */
  subject?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["messages"] as const;
type DiscordKindGroup = (typeof DEFAULT_INCLUDE)[number];

export function createDiscordConnector(
  config: DiscordConnectorConfig,
): StatewaveConnector<DiscordConnectorConfig, DiscordEvent> {
  if (!config.guildId) {
    throw new ConnectorError(
      "the discord connector requires a guildId — pass --guild <id>",
      {
        code: "config_invalid",
        connector: "discord",
        hint:
          "find the guild id by enabling Developer Mode in Discord, then right-clicking the server icon → Copy Server ID",
      },
    );
  }
  if (!config.channels || config.channels.length === 0) {
    throw new ConnectorError(
      "the discord connector requires at least one channel — pass --channels <id-or-name>[,…]",
      {
        code: "config_invalid",
        connector: "discord",
        hint: "ingesting an entire guild by default would be expensive and surprising",
      },
    );
  }

  const clientOptions: DiscordClientOptions = {
    token: config.token,
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl,
  };
  const client = new DiscordClient(clientOptions);

  // Cache resolved guild + channels across `check()` and `sync()` to avoid
  // paying the auth/list cost twice within a single process lifetime.
  let guild: DiscordGuild | undefined;
  let resolvedChannels: ReadonlyArray<DiscordChannel> | undefined;

  async function ensureGuild(): Promise<DiscordGuild> {
    if (guild) return guild;
    guild = await client.getGuild(config.guildId);
    return guild;
  }

  async function ensureChannels(): Promise<ReadonlyArray<DiscordChannel>> {
    if (resolvedChannels) return resolvedChannels;
    resolvedChannels = await client.resolveChannels(config.guildId, config.channels);
    return resolvedChannels;
  }

  return {
    id: `discord:${config.guildId}`,
    name: "Discord",
    source: "discord",

    async configure(_next: DiscordConnectorConfig): Promise<void> {
      throw new ConnectorError("discord connector is configured at construction time", {
        code: "unsupported",
        connector: "discord",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      const details: Array<{ name: string; status: "ok" | "warn" | "error"; message?: string }> = [];
      let status: "ok" | "warn" | "error" = "ok";
      try {
        const me = await client.authMe();
        details.push({
          name: "auth",
          status: "ok",
          message: me.username ? `@${me.username} (${me.id})` : me.id,
        });
      } catch (err) {
        status = "error";
        details.push({
          name: "auth",
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        return { connector: "discord", status, details };
      }
      try {
        const g = await ensureGuild();
        details.push({
          name: "guild",
          status: "ok",
          message: g.name ? `${g.name} (${g.id})` : g.id,
        });
      } catch (err) {
        status = "error";
        details.push({
          name: "guild",
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        return { connector: "discord", status, details };
      }
      try {
        const channels = await ensureChannels();
        details.push({
          name: "channels",
          status: "ok",
          message: channels.map((c) => c.name ?? c.id).join(", "),
        });
      } catch (err) {
        status = "error";
        details.push({
          name: "channels",
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return { connector: "discord", status, details };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const g = await ensureGuild();
      const channels = await ensureChannels();
      const subject = options.subject ?? config.subject ?? defaultSubject(g);
      const since = options.since ? new Date(options.since).toISOString() : undefined;

      const events: DiscordMessage[] = [];
      if (groups.has("messages")) {
        for (const channel of channels) {
          const msgs = await client.listChannelMessages(channel, g, {
            since,
            maxItems: options.maxItems,
          });
          for (const m of msgs) events.push(m);
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const ep = mapDiscordEvent(ev, { subject });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      const threadReplies = limited.filter((m) => isThreadChannelType(m.channel.type)).length;
      const topLevel = limited.length - threadReplies;
      const details: Record<string, number> = {
        events_fetched: events.length,
        events_mapped: episodes.length,
        events_messages: topLevel,
        events_thread_replies: threadReplies,
        channels_synced: channels.length,
      };

      return {
        connector: "discord",
        source: "discord",
        subject,
        episodes,
        ingested,
        skipped: events.length - episodes.length,
        dryRun,
        startedAt,
        finishedAt,
        summary: summarizeEpisodes(episodes, details),
      };
    },

    async mapEvent(event: DiscordEvent): Promise<StatewaveEpisode> {
      return mapDiscordEvent(event, {
        subject: config.subject ?? defaultSubject(event.guild),
      });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<DiscordKindGroup> {
  const base = new Set<DiscordKindGroup>(
    include?.length ? (include as DiscordKindGroup[]) : DEFAULT_INCLUDE,
  );
  if (exclude) for (const e of exclude) base.delete(e as DiscordKindGroup);
  return base;
}

function isThreadChannelType(type: number | undefined): boolean {
  return type === 10 || type === 11 || type === 12;
}
