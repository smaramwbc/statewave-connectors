// Public types for the Discord connector. Models the slice of Discord's
// API the v0.1 pull connector reads — channel messages and active
// threads. Forum channels, reactions, and the realtime Gateway protocol
// are deliberately out of scope here; if/when we add them they bring
// their own event kinds.

export type DiscordEventKind =
  | "discord.message.posted"
  | "discord.thread.replied";

/** A Discord guild ("server" in the UI). Used to root the default subject. */
export interface DiscordGuild {
  id: string;
  name?: string;
}

/** A Discord channel — either a normal text channel or a thread. */
export interface DiscordChannel {
  id: string;
  /** Channel name without leading `#`. May be undefined when the connector
   * resolved by id only. */
  name?: string;
  /** Discord channel types: 0 = text, 11 = public thread, 12 = private thread. */
  type?: number;
  /** Set on threads — id of the parent text channel. */
  parent_id?: string;
}

/** Discord user record (we only ingest `id` + `username` in v0.1). */
export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string;
}

/**
 * One Discord message we ingest. The mapper picks `discord.message.posted`
 * vs `discord.thread.replied` based on whether the channel is a thread
 * (parent_id present) or a top-level text channel.
 */
export interface DiscordMessage {
  type: "message";
  /** Discord message id (snowflake). Doubles as the timestamp source. */
  id: string;
  channel: DiscordChannel;
  guild: DiscordGuild;
  author: DiscordUser;
  /** Message text. Discord allows empty strings for embed-only messages;
   * the connector skips those. */
  content: string;
  /** ISO-8601 timestamp of when Discord stored the message. */
  timestamp: string;
  /** Set when the message was edited; we don't ingest edits as separate
   * episodes in v0.1 but pass it through metadata. */
  edited_timestamp?: string | null;
  /** Discord type code: 0 = default, 19 = reply, 21 = thread starter, …
   * v0.1 ingests only types we recognise as conversational content. */
  message_type?: number;
}

export type DiscordEvent = DiscordMessage;
