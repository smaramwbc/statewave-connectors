// Slack-message → Statewave-episode mapping. Kept side-effect-free and
// independent of the Slack client so it's straightforward to unit-test
// against synthetic message fixtures.

import { EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type { SlackEventKind, SlackMessage, SlackUser, SlackWorkspace } from "./types.js";

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
  const subject = options.subject ?? defaultSubject(options.workspace);
  const builder = new EpisodeBuilder({
    subject,
    metadata: {
      workspace_id: options.workspace.team_id,
      workspace_name: options.workspace.team_name,
      channel_id: message.channel.id,
      channel_name: message.channel.name,
    },
  });

  const isThreadReply =
    typeof message.thread_ts === "string" && message.thread_ts !== message.ts;
  const kind: SlackEventKind = isThreadReply
    ? "slack.thread.replied"
    : "slack.message.posted";

  const author = resolveAuthorLabel(message, options.userDirectory);
  const text = composeMessageText(message, author, options.userDirectory);

  return builder.build({
    kind,
    text,
    occurred_at: tsToIso(message.ts),
    source: {
      type: isThreadReply ? "slack.thread.reply" : "slack.message",
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
    // shape is safe across re-runs of the same `--since` window.
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
): string {
  const channelLabel = message.channel.name ? `#${message.channel.name}` : message.channel.id;
  const expanded = directory ? expandMentions(message.text, directory) : message.text;
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
