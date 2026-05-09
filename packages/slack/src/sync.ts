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
   * `#general`). At least one is required UNLESS `includeDms` is true, so
   * a first run never accidentally sucks in an entire workspace.
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
  /**
   * Opt in to DM ingestion. When true, the connector lists every direct
   * message conversation the bot has access to (via
   * `conversations.list?types=im`) and ingests their history alongside the
   * channel allowlist. Episodes land under `dm:<other_user_id>` so each
   * human's DM thread with the bot is its own subject. Requires the
   * `im:read` and `im:history` scopes on the bot token.
   *
   * **DMs are sensitive.** This flag is opt-in for a reason: in shared
   * Slack workspaces the bot may have inbound DMs from people who didn't
   * explicitly consent to having their messages stored elsewhere. Verify
   * your workspace's privacy posture before flipping it on in production.
   */
  includeDms?: boolean;
  /**
   * Opt in to multi-party DM (group DM) ingestion. When true, the
   * connector lists every mpim the bot is a member of (via
   * `conversations.list?types=mpim`) and ingests their history. MPIMs
   * have no single "other party", so episodes land under
   * `mpim:<channel_id>` (the channel's stable Slack id). Requires the
   * `mpim:read` and `mpim:history` scopes on the bot token.
   *
   * Same privacy disclaimer as `includeDms` — group DMs are also opt-in
   * because in shared workspaces other participants didn't necessarily
   * consent to having their messages mirrored elsewhere.
   */
  includeMpim?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["messages", "thread_replies"] as const;
type SlackKindGroup = (typeof DEFAULT_INCLUDE)[number];

export function createSlackConnector(
  config: SlackConnectorConfig,
): StatewaveConnector<SlackConnectorConfig, SlackEvent> {
  const channelCount = config.channels?.length ?? 0;
  if (channelCount === 0 && !config.includeDms && !config.includeMpim) {
    throw new ConnectorError(
      "the slack connector requires --channels <id-or-name>[,…], --include-dms, or --include-mpim",
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
  let resolvedDms: ReadonlyArray<SlackChannelRef> | undefined;
  let resolvedMpims: ReadonlyArray<SlackChannelRef> | undefined;

  async function ensureWorkspace(): Promise<SlackWorkspace> {
    if (workspace) return workspace;
    workspace = await client.authTest();
    return workspace;
  }

  async function ensureChannels(): Promise<ReadonlyArray<SlackChannelRef>> {
    if (resolvedChannels) return resolvedChannels;
    resolvedChannels = channelCount > 0 ? await client.resolveChannels(config.channels) : [];
    return resolvedChannels;
  }

  async function ensureDms(): Promise<ReadonlyArray<SlackChannelRef>> {
    if (!config.includeDms) return [];
    if (resolvedDms) return resolvedDms;
    resolvedDms = await client.listDmConversations();
    return resolvedDms;
  }

  async function ensureMpims(): Promise<ReadonlyArray<SlackChannelRef>> {
    if (!config.includeMpim) return [];
    if (resolvedMpims) return resolvedMpims;
    resolvedMpims = await client.listMpimConversations();
    return resolvedMpims;
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
      const dms = await ensureDms();
      const mpims = await ensureMpims();
      const subject = options.subject ?? config.subject ?? defaultSubject(ws);
      const since = options.since ? new Date(options.since).toISOString() : undefined;

      const events: SlackMessage[] = [];
      // DM/MPIM messages need their channel ref preserved with the right
      // discriminator flag so the mapper picks the correct kind + subject.
      // We track which channel produced each thread parent so the replies
      // inherit the same DM/MPIM-ness.
      const threadParents: Array<{ channel: SlackChannelRef; ts: string }> = [];

      // Iterate channels + DMs + MPIMs together — all three get
      // `listChannelMessages` / `listThreadReplies` (Slack uses the same
      // endpoints for every conversation type) and the mapper differentiates
      // downstream via `channel.is_im` / `channel.is_mpim`.
      const targets: ReadonlyArray<SlackChannelRef> = [...channels, ...dms, ...mpims];

      if (groups.has("messages")) {
        for (const target of targets) {
          const msgs = await client.listChannelMessages(target, { since });
          for (const m of msgs) {
            // Stamp the channel ref so the mapper sees `is_im` + `dm_user_id`
            // for DMs (the client doesn't know whether the channel was
            // resolved as a DM or a normal channel).
            const stamped: SlackMessage = {
              ...m,
              channel: target,
            };
            events.push(stamped);
            if ((stamped.reply_count ?? 0) > 0 && groups.has("thread_replies")) {
              threadParents.push({ channel: target, ts: stamped.ts });
            }
          }
        }
      }

      if (groups.has("thread_replies")) {
        for (const parent of threadParents) {
          const replies = await client.listThreadReplies(parent.channel, parent.ts);
          for (const r of replies) {
            events.push({ ...r, channel: parent.channel });
          }
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);

      const userDirectory = config.resolveUsers
        ? await buildUserDirectory(client, limited)
        : undefined;

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        // Pass the channel-ref-anchored subject when the message is a
        // DM (per-user) or MPIM (per-group). Channel messages still flow
        // through the global `subject` override.
        const perEventSubject =
          ev.channel.is_im && ev.channel.dm_user_id
            ? options.subject ?? config.subject ?? `dm:${ev.channel.dm_user_id}`
            : ev.channel.is_mpim
              ? options.subject ?? config.subject ?? `mpim:${ev.channel.id}`
              : subject;
        const ep = mapSlackEvent(ev, {
          workspace: ws,
          subject: perEventSubject,
          userDirectory,
        });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      const dmCount = limited.filter((m) => m.channel.is_im).length;
      const mpimCount = limited.filter((m) => m.channel.is_mpim).length;
      const messagesCount = limited.filter(
        (m) =>
          !m.channel.is_im &&
          !m.channel.is_mpim &&
          (m.thread_ts ?? m.ts) === m.ts,
      ).length;
      const threadRepliesCount = limited.filter(
        (m) =>
          !m.channel.is_im &&
          !m.channel.is_mpim &&
          (m.thread_ts ?? m.ts) !== m.ts,
      ).length;
      const details: Record<string, number> = {
        events_fetched: events.length,
        events_mapped: episodes.length,
        events_messages: messagesCount,
        events_thread_replies: threadRepliesCount,
        events_dms: dmCount,
        events_mpims: mpimCount,
        channels_synced: channels.length,
        dms_synced: dms.length,
        mpims_synced: mpims.length,
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
