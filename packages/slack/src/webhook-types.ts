// Slack Events-API payload types — what the Webhook handler reads off the
// body. We model only the fields the handler actually consumes; Slack's
// real payloads carry more (authed_users, api_app_id, …) but ignoring
// extras is fine.

export interface SlackUrlVerification {
  type: "url_verification";
  challenge: string;
  /** Slack also includes `token` here; we don't read it (signing-secret
   * verification covers authenticity). */
  token?: string;
}

export interface SlackEventCallback {
  type: "event_callback";
  event_id: string;
  event_time?: number;
  team_id: string;
  event: SlackInboundEvent;
}

export type SlackInboundEvent =
  | SlackInboundMessage
  | SlackInboundReaction
  | SlackInboundPin;

export interface SlackInboundMessage {
  type: "message";
  /** Channel id the message was posted in. We compare this against the
   * allowlist to decide whether to ingest. */
  channel: string;
  /** Channel category Slack assigns: `"channel"` for public channels,
   * `"group"` for private channels, `"im"` for 1:1 DMs the bot is in,
   * `"mpim"` for multi-party DMs. v0.4.0 routes `im` / `mpim` through
   * the same DM/MPIM kinds used in pull mode (`slack.dm.message.posted`
   * / `slack.mpim.message.posted`) when the corresponding `acceptDms`
   * / `acceptMpim` config flag is on. */
  channel_type?: "channel" | "group" | "im" | "mpim" | string;
  /** User id that authored the message; absent for some bot messages. */
  user?: string;
  bot_id?: string;
  text?: string;
  /** Slack message timestamp — also doubles as the unique id. */
  ts: string;
  /** Present when this is a thread reply; equal to `ts` for top-level. */
  thread_ts?: string;
  /** Slack tags certain message subtypes (channel_join, channel_leave,
   * file_share without text, …) we deliberately skip. */
  subtype?: string;
}

/**
 * `reaction_added` / `reaction_removed` events. Slack puts the reacted-to
 * message under `item`, with the channel and timestamp we can use to build
 * a permalink. We don't fetch the parent message body inline — that would
 * add an API call per reaction; the message text travels through the
 * standalone `message` event when it was originally posted.
 */
export interface SlackInboundReaction {
  type: "reaction_added" | "reaction_removed";
  /** User who reacted. */
  user: string;
  /** Emoji name without colons (e.g. `thumbsup`). */
  reaction: string;
  /** Author of the message that received the reaction (when known). */
  item_user?: string;
  /** Slack `item` discriminates by `type`; only `message` items make it
   * into v0.3. File / file_comment item types fall on the floor. */
  item: {
    type: "message" | string;
    channel: string;
    ts: string;
  };
  /** Slack's wall-clock for the reaction event. */
  event_ts: string;
}

/**
 * `pin_added` / `pin_removed` events. Slack inlines the pinned message
 * under `item.message` (unlike reactions, which only carry a reference).
 */
export interface SlackInboundPin {
  type: "pin_added" | "pin_removed";
  /** User who pinned / unpinned. */
  user: string;
  /** Channel where the pin happened. */
  channel_id: string;
  item: {
    type: "message" | string;
    channel: string;
    created: number;
    created_by?: string;
    message?: {
      ts: string;
      user?: string;
      text?: string;
      thread_ts?: string;
    };
  };
  event_ts: string;
}

/**
 * Discriminated union of inbound webhook payloads we handle. Anything else
 * gets a 200 + a no-op response so Slack stops retrying.
 */
export type SlackWebhookPayload = SlackUrlVerification | SlackEventCallback;
