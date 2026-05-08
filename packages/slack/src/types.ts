// Public types for the Slack connector. We model only the fields the v0.1
// pull-mode connector actually reads — keeping the surface small reduces the
// blast radius if Slack's API response shape drifts. Live Events-API support
// (Phase 2) will introduce additional event shapes alongside these.

export type SlackEventKind = "slack.message.posted" | "slack.thread.replied";

/** Workspace identity. Resolved from `auth.test` when not provided explicitly. */
export interface SlackWorkspace {
  team_id: string;
  /** Optional vanity / display label. Used in episode metadata, never in IDs. */
  team_name?: string;
}

/** Channel identity passed through to mappers. */
export interface SlackChannelRef {
  id: string;
  /** Channel name without leading `#`. May be undefined if the connector resolved by id only. */
  name?: string;
  is_private?: boolean;
}

/** A user record we may have looked up to attach a stable display name. */
export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
}

/**
 * One Slack message we ingest. We accept either a top-level channel message
 * (no `thread_ts`, or `thread_ts === ts`) or a thread reply (`thread_ts !==
 * ts`). The mapper picks the kind based on that relationship.
 */
export interface SlackMessage {
  type: "message";
  /** Slack timestamp acting as the message ID, e.g. `1700000000.123456`. */
  ts: string;
  /** Parent thread root timestamp; equal to `ts` for top-level messages. */
  thread_ts?: string;
  channel: SlackChannelRef;
  user?: SlackUser | null;
  /** Bots set this in addition to or instead of `user`. */
  bot_id?: string | null;
  /** Raw text — Slack mrkdwn, including `<@Uxxx>` mentions and `<http…|label>` links. */
  text: string;
  /** Permalink (only present when the connector resolved it). */
  permalink?: string;
  /** Number of replies, only set on thread parents. */
  reply_count?: number;
}

export type SlackEvent = SlackMessage;
