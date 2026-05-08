// Top-level `createSlackConnector` that the CLI (and SDK consumers) wire up.
// Pull-mode only for v0.1 — channel and thread history via the Slack Web
// API. Live Events-API mode lands later as a separate `start()` surface.

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
import { SlackClient, type SlackClientOptions } from "./client.js";
import { defaultSubject, mapSlackEvent } from "./mapper.js";
import type { SlackChannelRef, SlackEvent, SlackMessage, SlackUser, SlackWorkspace } from "./types.js";

export interface SlackConnectorConfig {
  /** Bot token (`xoxb-…`). Required. */
  token: string;
  /**
   * Channel selectors — either ids (`C0123…`) or names (`general`,
   * `#general`). At least one is required so we don't accidentally suck in
   * an entire workspace on first run.
   */
  channels: ReadonlyArray<string>;
  /** Override subject. Defaults to `team:<team_id>` from `auth.test`. */
  subject?: string;
  /**
   * Optional pre-resolved workspace identity. The CLI normally lets the
   * connector probe `auth.test` itself; tests can pass this in to skip the
   * extra HTTP round-trip.
   */
  workspace?: SlackWorkspace;
  /**
   * Resolve user display names for `<@Uxxx>` mention expansion. Defaults to
   * `false` since each lookup costs an extra Slack API call per unique
   * author and the rendered text is fine without it.
   */
  resolveUsers?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["messages", "thread_replies"] as const;
type SlackKindGroup = (typeof DEFAULT_INCLUDE)[number];

export function createSlackConnector(
  config: SlackConnectorConfig,
): StatewaveConnector<SlackConnectorConfig, SlackEvent> {
  if (!config.channels || config.channels.length === 0) {
    throw new ConnectorError(
      "the slack connector requires at least one channel — pass --channels <id-or-name>[,…]",
      {
        code: "config_invalid",
        connector: "slack",
        hint: "ingesting an entire workspace by default would be expensive and surprising",
      },
    );
  }

  const clientOptions: SlackClientOptions = {
    token: config.token,
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl,
  };
  const client = new SlackClient(clientOptions);

  // Capture state across `check()` and `sync()` — once we've resolved the
  // workspace + channel directory, we keep them so a follow-up sync doesn't
  // pay the auth.test cost a second time within the same process lifetime.
  let workspace: SlackWorkspace | undefined = config.workspace;
  let resolvedChannels: ReadonlyArray<SlackChannelRef> | undefined;

  async function ensureWorkspace(): Promise<SlackWorkspace> {
    if (workspace) return workspace;
    workspace = await client.authTest();
    return workspace;
  }

  async function ensureChannels(): Promise<ReadonlyArray<SlackChannelRef>> {
    if (resolvedChannels) return resolvedChannels;
    resolvedChannels = await client.resolveChannels(config.channels);
    return resolvedChannels;
  }

  return {
    id: `slack:${config.channels.join(",")}`,
    name: "Slack",
    source: "slack",

    async configure(_next: SlackConnectorConfig): Promise<void> {
      throw new ConnectorError("slack connector is configured at construction time", {
        code: "unsupported",
        connector: "slack",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      const details: Array<{
        name: string;
        status: "ok" | "warn" | "error";
        message?: string;
      }> = [];
      let status: "ok" | "warn" | "error" = "ok";
      try {
        const ws = await ensureWorkspace();
        details.push({
          name: "auth",
          status: "ok",
          message: ws.team_name ? `${ws.team_name} (${ws.team_id})` : ws.team_id,
        });
      } catch (err) {
        status = "error";
        details.push({
          name: "auth",
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        return { connector: "slack", status, details };
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
      return { connector: "slack", status, details };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const ws = await ensureWorkspace();
      const channels = await ensureChannels();
      const subject = options.subject ?? config.subject ?? defaultSubject(ws);
      const since = options.since ? new Date(options.since).toISOString() : undefined;

      const events: SlackMessage[] = [];

      // Top-level channel messages first. We capture thread parents we'll
      // need to fetch replies for as a side product — saves a second pass
      // over the message list.
      const threadParents: Array<{ channel: SlackChannelRef; ts: string }> = [];
      if (groups.has("messages")) {
        for (const channel of channels) {
          const msgs = await client.listChannelMessages(channel, { since });
          for (const m of msgs) {
            events.push(m);
            if ((m.reply_count ?? 0) > 0 && groups.has("thread_replies")) {
              threadParents.push({ channel, ts: m.ts });
            }
          }
        }
      }

      // Thread replies, fetched only for parents we observed above. This
      // means a `since`-windowed sync correctly picks up replies to
      // messages that fell within the window, without a separate full-
      // workspace scan.
      if (groups.has("thread_replies")) {
        for (const parent of threadParents) {
          const replies = await client.listThreadReplies(parent.channel, parent.ts);
          for (const r of replies) events.push(r);
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);

      const userDirectory = config.resolveUsers
        ? await buildUserDirectory(client, limited)
        : undefined;

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const ep = mapSlackEvent(ev, {
          workspace: ws,
          subject,
          userDirectory,
        });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      const messagesCount = limited.filter((m) => (m.thread_ts ?? m.ts) === m.ts).length;
      const threadRepliesCount = limited.length - messagesCount;
      const details: Record<string, number> = {
        events_fetched: events.length,
        events_mapped: episodes.length,
        events_messages: messagesCount,
        events_thread_replies: threadRepliesCount,
        channels_synced: channels.length,
      };

      return {
        connector: "slack",
        source: "slack",
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

    async mapEvent(event: SlackEvent): Promise<StatewaveEpisode> {
      const ws = await ensureWorkspace();
      return mapSlackEvent(event, {
        workspace: ws,
        subject: config.subject ?? defaultSubject(ws),
      });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<SlackKindGroup> {
  const base = new Set<SlackKindGroup>(
    include?.length ? (include as SlackKindGroup[]) : DEFAULT_INCLUDE,
  );
  if (exclude) for (const e of exclude) base.delete(e as SlackKindGroup);
  return base;
}

/** Resolve every author id mentioned in the message set into a display
 * name, for nicer mention rendering. Cached per-id so we never look up the
 * same user twice in a single sync. */
async function buildUserDirectory(
  client: SlackClient,
  messages: ReadonlyArray<SlackMessage>,
): Promise<ReadonlyMap<string, SlackUser>> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.user?.id) ids.add(m.user.id);
    for (const match of m.text.matchAll(/<@([A-Z0-9]+)>/g)) {
      const id = match[1];
      if (id) ids.add(id);
    }
  }
  const dir = new Map<string, SlackUser>();
  for (const id of ids) {
    const user = await client.lookupUser(id);
    if (user) dir.set(id, user);
  }
  return dir;
}
