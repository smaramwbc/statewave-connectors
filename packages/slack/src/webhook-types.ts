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

export type SlackInboundEvent = {
  type: "message";
  /** Channel id the message was posted in. We compare this against the
   * allowlist to decide whether to ingest. */
  channel: string;
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
};

/**
 * Discriminated union of inbound webhook payloads we handle. Anything else
 * gets a 200 + a no-op response so Slack stops retrying.
 */
export type SlackWebhookPayload = SlackUrlVerification | SlackEventCallback;
