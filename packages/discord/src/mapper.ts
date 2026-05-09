// Discord-message → Statewave-episode mapping. Side-effect-free; the
// connector resolves channels and authors before calling this so the
// mapper itself is a pure transformation.

import { EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type {
  DiscordEventKind,
  DiscordGuild,
  DiscordMessage,
} from "./types.js";

export interface MapperOptions {
  /** Override for the default `community:<guild_id>` subject. */
  subject?: string;
}

export function defaultSubject(guild: DiscordGuild): string {
  // Guild IDs (snowflakes) are stable — using them keeps subject names
  // safe to reuse across guild renames. Operators who want a friendlier
  // subject can pass `--subject community:<name>` instead.
  return `community:${guild.id}`;
}

export function mapDiscordEvent(
  message: DiscordMessage,
  options: MapperOptions = {},
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(message.guild);
  const isThreadReply = isThreadChannel(message.channel.type);
  const kind: DiscordEventKind = isThreadReply
    ? "discord.thread.replied"
    : "discord.message.posted";

  const author = resolveAuthorLabel(message);
  const channelLabel = message.channel.name
    ? `#${message.channel.name}`
    : message.channel.id;
  const text = `${author} in ${channelLabel}: ${message.content}`;

  const builder = new EpisodeBuilder({
    subject,
    metadata: {
      guild_id: message.guild.id,
      guild_name: message.guild.name,
      channel_id: message.channel.id,
      channel_name: message.channel.name,
      channel_type: message.channel.type,
    },
  });

  return builder.build({
    kind,
    text,
    occurred_at: message.timestamp,
    source: {
      type: isThreadReply ? "discord.thread.reply" : "discord.message",
      id: `${message.channel.id}:${message.id}`,
      url: buildPermalink(message),
    },
    metadata: {
      author_id: message.author.id,
      author_label: author,
      message_type: message.message_type ?? null,
      edited_timestamp: message.edited_timestamp ?? null,
      parent_id: message.channel.parent_id ?? null,
    },
    // Channel id + message id is unique within Discord, so this idempotency
    // shape is safe across re-runs of the same `--since` window.
    idempotency_parts: [
      "discord",
      message.guild.id,
      message.channel.id,
      message.id,
      kind,
    ],
  });
}

/**
 * Discord channel types: 0 = text, 5 = announcement, 10 = announcement
 * thread, 11 = public thread, 12 = private thread, 15 = forum. We treat
 * any thread-like channel (10/11/12) as a thread reply, and everything
 * else as a top-level message.
 */
function isThreadChannel(type: number | undefined): boolean {
  return type === 10 || type === 11 || type === 12;
}

function resolveAuthorLabel(message: DiscordMessage): string {
  const a = message.author;
  if (a.global_name) return a.global_name;
  if (a.username) return a.username;
  return `<@${a.id}>`;
}

/**
 * Discord permalinks have the shape `https://discord.com/channels/<guild>/<channel>/<message>`.
 * Reachable to anyone with View Channel permission on the channel.
 */
function buildPermalink(message: DiscordMessage): string {
  return `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
}
