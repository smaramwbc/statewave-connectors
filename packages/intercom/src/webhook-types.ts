// Intercom webhook payload types. Intercom delivers a stable JSON
// envelope for every Notification topic; the operator subscribes to a
// set of topics in Developer Hub → Webhooks and Intercom POSTs each
// event with `topic`, `id`, and a `data.item` block that is the full
// resource state at event time.
//
// Reference: https://developers.intercom.com/docs/references/webhooks

/**
 * Top-level envelope. Intercom's `type` is always `notification_event`;
 * the discriminator we route on is `topic`.
 */
export interface IntercomWebhookEvent {
  /** Always `notification_event` for Intercom-issued webhooks. */
  type: string;
  /** Stable id for retry dedup. Intercom retries with the same id. */
  id: string;
  /** Workspace (app) id this event came from. */
  app_id?: string;
  /** Notification topic, e.g. `conversation.user.created`. */
  topic: IntercomWebhookTopic | string;
  /** Unix epoch seconds. */
  created_at?: number;
  data: {
    type?: string;
    /** Full resource snapshot at event time. For conversation topics
     * this is an `IntercomWebhookConversation`; for other topics we
     * accept and skip without choking. */
    item: IntercomWebhookConversation | Record<string, unknown>;
  };
}

/**
 * Subset of Intercom webhook topics the receiver dispatches on. Other
 * topics are accepted and 200-ack'd with `ignored: "unknown_topic"`.
 */
export type IntercomWebhookTopic =
  | "conversation.user.created"
  | "conversation.user.replied"
  | "conversation.admin.replied"
  | "conversation.admin.noted"
  | "conversation.admin.closed";

/**
 * The shape Intercom puts into `data.item` for conversation topics. A
 * full conversation snapshot — significantly bigger than the slim
 * `IntercomConversation` the pull connector already models. We adopt
 * just the fields the mapper needs and treat the rest as opaque.
 */
export interface IntercomWebhookConversation {
  type?: "conversation";
  id: string;
  /** Unix epoch seconds. */
  created_at?: number;
  updated_at?: number;
  state?: string;
  priority?: string;
  tags?: { tags?: ReadonlyArray<{ name?: string }> } | ReadonlyArray<string>;
  /** First message of the conversation. */
  source?: {
    type?: string;
    id?: string;
    body?: string;
    subject?: string;
    /** Author of the opening message. */
    author?: {
      type?: string;
      id?: string;
      email?: string;
      name?: string;
    };
  };
  /** First contact attached. Some payloads put this under `contacts`. */
  contacts?: {
    contacts?: ReadonlyArray<{
      type?: string;
      id: string;
      name?: string | null;
      email?: string | null;
      external_id?: string | null;
      role?: string;
    }>;
  };
  /** Conversation parts (replies + admin actions) attached at event time. */
  conversation_parts?: {
    conversation_parts?: ReadonlyArray<IntercomWebhookConversationPart>;
  };
  assignee?: { type?: string; id?: string | null };
  team_assignee_id?: string | null;
}

export interface IntercomWebhookConversationPart {
  id: string;
  /** Discriminator: "comment", "note", "assignment", "close", "open", … */
  part_type: string;
  body?: string | null;
  /** Unix epoch seconds. */
  created_at?: number;
  author?: {
    type?: string;
    id?: string | null;
    name?: string | null;
    email?: string | null;
  };
}
