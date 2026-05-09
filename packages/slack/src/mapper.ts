// Slack-message → Statewave-episode mapping. Kept side-effect-free and
// independent of the Slack client so it's straightforward to unit-test
// against synthetic message fixtures.

import { EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type { SlackEventKind, SlackMessage, SlackUser, SlackWorkspace } from "./types.js";
import type { SlackInboundPin, SlackInboundReaction } from "./webhook-types.js";

export interface MapperOptions {
  workspace: SlackWorkspace;
  subject?: string;
  /** Optional id → display-name map to render `<@Uxxx>` mentions in episode text. */
  userDirectory?: ReadonlyMap<string, SlackUser>;
}

export function defaultSubject(workspace: SlackWorkspace): string {
  // Slack workspace IDs (`T…`) are stable and globally unique — using them
  // keeps subject names safe to reuse across renamed workspaces. Operators
  // who want a friendlier subject can pass `--subject team:<name>` instead.
  return `team:${workspace.team_id}`;
}

export function mapSlackEvent(message: SlackMessage, options: MapperOptions): StatewaveEpisode {
  const isDm = !!message.channel.is_im;
  const isMpim = !!message.channel.is_mpim;
  const isThreadReply =
    typeof message.thread_ts === "string" && message.thread_ts !== message.ts;

  // DMs route under `dm:<other_user_id>`, MPIMs (group DMs) route under
  // `mpim:<channel_id>` (no single "other party"), and channel messages
  // route under the workspace-default `team:<team_id>`.
  const subject =
    options.subject ??
    (isDm && message.channel.dm_user_id
      ? `dm:${message.channel.dm_user_id}`
      : isMpim
        ? `mpim:${message.channel.id}`
        : defaultSubject(options.workspace));

  const kind: SlackEventKind = isDm
    ? isThreadReply
      ? "slack.dm.thread.replied"
      : "slack.dm.message.posted"
    : isMpim
      ? isThreadReply
        ? "slack.mpim.thread.replied"
        : "slack.mpim.message.posted"
      : isThreadReply
        ? "slack.thread.replied"
        : "slack.message.posted";

  const builder = new EpisodeBuilder({
    subject,
    metadata: {
      workspace_id: options.workspace.team_id,
      workspace_name: options.workspace.team_name,
      channel_id: message.channel.id,
      channel_name: message.channel.name,
      // DM-specific metadata — null for channel messages so consumers can
      // route on it without a special-case discriminator.
      dm_user_id: isDm ? message.channel.dm_user_id ?? null : null,
      is_mpim: isMpim ? true : null,
    },
  });

  const author = resolveAuthorLabel(message, options.userDirectory);
  const text = composeMessageText(message, author, options.userDirectory, isDm, isMpim);

  return builder.build({
    kind,
    text,
    occurred_at: tsToIso(message.ts),
    source: {
      type: isDm
        ? isThreadReply
          ? "slack.dm.thread.reply"
          : "slack.dm.message"
        : isMpim
          ? isThreadReply
            ? "slack.mpim.thread.reply"
            : "slack.mpim.message"
          : isThreadReply
            ? "slack.thread.reply"
            : "slack.message",
      id: `${message.channel.id}:${message.ts}`,
      url: message.permalink,
    },
    metadata: {
      author_id: message.user?.id ?? null,
      author_label: author,
      bot_id: message.bot_id ?? null,
      thread_ts: message.thread_ts ?? null,
      reply_count: message.reply_count ?? 0,
    },
    // Channel id + ts is unique within a workspace, so this idempotency
    // shape is safe across re-runs of the same `--since` window. The kind
    // discriminator means a DM and a channel message with somehow-equal
    // ts wouldn't dedup against each other (defensive — Slack assigns
    // ts globally unique anyway).
    idempotency_parts: ["slack", options.workspace.team_id, message.channel.id, message.ts, kind],
  });
}

/**
 * Build the human-readable episode text for a message. The shape mirrors how
 * a support agent would reference Slack history in a chat: "<author> in
 * #<channel>: <message>". Mention placeholders are expanded inline when we
 * have a user directory, otherwise left as `<@Uxxx>` so the original Slack
 * link round-trips losslessly.
 */
function composeMessageText(
  message: SlackMessage,
  author: string,
  directory?: ReadonlyMap<string, SlackUser>,
  isDm = false,
  isMpim = false,
): string {
  const expanded = directory ? expandMentions(message.text, directory) : message.text;
  if (isDm) {
    // DM rendering: "<author> (DM): <text>" — channel labels are noisy for
    // DMs because they're per-user-pair anyway and the channel id is the
    // synthetic D… snowflake.
    return `${author} (DM): ${expanded}`;
  }
  if (isMpim) {
    // Group-DM rendering: "<author> (group DM): <text>" — same reasoning
    // as DMs (the channel id is the synthetic G… snowflake), with "group
    // DM" instead of "DM" so consumers can tell them apart in episode
    // text without parsing metadata.
    return `${author} (group DM): ${expanded}`;
  }
  const channelLabel = message.channel.name ? `#${message.channel.name}` : message.channel.id;
  return `${author} in ${channelLabel}: ${expanded}`;
}

function resolveAuthorLabel(
  message: SlackMessage,
  directory?: ReadonlyMap<string, SlackUser>,
): string {
  if (message.user?.id) {
    const lookup = directory?.get(message.user.id);
    if (lookup?.real_name) return lookup.real_name;
    if (lookup?.name) return lookup.name;
    return `<@${message.user.id}>`;
  }
  if (message.bot_id) return `bot:${message.bot_id}`;
  return "unknown user";
}

function expandMentions(text: string, directory: ReadonlyMap<string, SlackUser>): string {
  return text.replace(/<@([A-Z0-9]+)>/g, (full, userId: string) => {
    const u = directory.get(userId);
    if (u?.real_name) return `@${u.real_name}`;
    if (u?.name) return `@${u.name}`;
    return full;
  });
}

/**
 * Slack timestamps are `<seconds>.<microseconds>` strings. Convert to
 * ISO-8601 for the episode's `occurred_at` field (the rest of Statewave
 * speaks ISO).
 */
function tsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) {
    return new Date().toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

export interface ReactionMapperOptions {
  workspace: SlackWorkspace;
  subject?: string;
  /** Channel name for the `item.channel` id, when the connector resolved it. */
  channelName?: string;
  /** Optional id → display-name map for the reactor. */
  userDirectory?: ReadonlyMap<string, SlackUser>;
}

/**
 * Map a Slack `reaction_added` / `reaction_removed` webhook event to an
 * episode. The episode text is intentionally reaction-shaped (not the
 * underlying message text) — re-deriving the parent message body here
 * would mean an extra API call per reaction; the message itself flows
 * through the separate `message` event when it was first posted.
 */
export function mapSlackReactionEvent(
  event: SlackInboundReaction,
  options: ReactionMapperOptions,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(options.workspace);
  const kind: SlackEventKind =
    event.type === "reaction_added" ? "slack.reaction.added" : "slack.reaction.removed";
  const reactor = resolveDirectoryLabel(event.user, options.userDirectory);
  const channelLabel = options.channelName ? `#${options.channelName}` : event.item.channel;
  const verb = event.type === "reaction_added" ? "reacted" : "removed reaction";
  const text = `${reactor} ${verb} :${event.reaction}: on message ${event.item.ts} in ${channelLabel}`;

  const builder = new EpisodeBuilder({
    subject,
    metadata: {
      workspace_id: options.workspace.team_id,
      workspace_name: options.workspace.team_name,
      channel_id: event.item.channel,
      channel_name: options.channelName,
    },
  });

  return builder.build({
    kind,
    text,
    occurred_at: tsToIso(event.event_ts),
    source: {
      type: kind === "slack.reaction.added" ? "slack.reaction.add" : "slack.reaction.remove",
      // Channel + parent ts + reactor + emoji is unique per reaction toggle.
      id: `${event.item.channel}:${event.item.ts}:${event.user}:${event.reaction}`,
    },
    metadata: {
      reactor_id: event.user,
      reactor_label: reactor,
      reaction: event.reaction,
      item_message_ts: event.item.ts,
      item_user_id: event.item_user ?? null,
    },
    idempotency_parts: [
      "slack",
      options.workspace.team_id,
      event.item.channel,
      event.item.ts,
      "reaction",
      event.reaction,
      event.user,
      kind,
    ],
  });
}

export interface PinMapperOptions {
  workspace: SlackWorkspace;
  subject?: string;
  channelName?: string;
  userDirectory?: ReadonlyMap<string, SlackUser>;
}

/**
 * Map a Slack `pin_added` / `pin_removed` webhook event to an episode.
 * Pins inline the message body, so the rendered text includes a snippet
 * of what was pinned — useful even without correlating back to the
 * original posting.
 */
export function mapSlackPinEvent(
  event: SlackInboundPin,
  options: PinMapperOptions,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(options.workspace);
  const kind: SlackEventKind =
    event.type === "pin_added" ? "slack.pin.added" : "slack.pin.removed";
  const pinner = resolveDirectoryLabel(event.user, options.userDirectory);
  const channelLabel = options.channelName ? `#${options.channelName}` : event.channel_id;
  const verb = event.type === "pin_added" ? "pinned" : "unpinned";
  const messageTs = event.item.message?.ts ?? "(unknown ts)";
  const messageSnippet = (event.item.message?.text ?? "").slice(0, 240);
  const text = messageSnippet
    ? `${pinner} ${verb} message ${messageTs} in ${channelLabel}: "${messageSnippet}"`
    : `${pinner} ${verb} message ${messageTs} in ${channelLabel}`;

  const builder = new EpisodeBuilder({
    subject,
    metadata: {
      workspace_id: options.workspace.team_id,
      workspace_name: options.workspace.team_name,
      channel_id: event.channel_id,
      channel_name: options.channelName,
    },
  });

  return builder.build({
    kind,
    text,
    occurred_at: tsToIso(event.event_ts),
    source: {
      type: kind === "slack.pin.added" ? "slack.pin.add" : "slack.pin.remove",
      id: `${event.channel_id}:${messageTs}`,
    },
    metadata: {
      pinner_id: event.user,
      pinner_label: pinner,
      message_ts: messageTs,
      message_user_id: event.item.message?.user ?? null,
      thread_ts: event.item.message?.thread_ts ?? null,
    },
    idempotency_parts: [
      "slack",
      options.workspace.team_id,
      event.channel_id,
      messageTs,
      "pin",
      kind,
    ],
  });
}

function resolveDirectoryLabel(
  userId: string,
  directory?: ReadonlyMap<string, SlackUser>,
): string {
  const u = directory?.get(userId);
  if (u?.real_name) return u.real_name;
  if (u?.name) return u.name;
  return `<@${userId}>`;
}
