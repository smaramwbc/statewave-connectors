// Public types for the Intercom connector. Models the slice of Intercom's
// REST API the v0.1 pull connector reads — conversations + their parts
// (replies and admin notes). The Messenger/Articles/Outbound surfaces and
// the realtime webhook stream are deliberately out of scope here; each
// brings its own event kinds and we'll add them when the use case earns it.

export type IntercomEventKind =
  | "intercom.conversation.created"
  | "intercom.conversation.closed"
  | "intercom.conversation.replied"
  | "intercom.conversation.note_added";

/**
 * Intercom hosts customer data in three regions. The connector talks to
 * the right edge so EU/AU operators don't accidentally route US traffic.
 * Default is `us` to match how most teams onboard.
 */
export type IntercomRegion = "us" | "eu" | "au";

/** Intercom contact (a Lead or User in their data model). */
export interface IntercomContact {
  id: string;
  name?: string | null;
  email?: string | null;
  external_id?: string | null;
  /** "lead" (anonymous), "user" (identified), or "visitor". */
  role?: string;
  /** Primary company id, when the contact has at least one. Convenience field
   * the client populates from the contact's `companies.data[0]` if present;
   * Intercom doesn't guarantee a "primary" attribute, but the first entry
   * is the conventional choice. */
  primary_company_id?: string | null;
  /** Friendly label for the primary company — best-effort enrichment. */
  primary_company_name?: string | null;
}

/** Intercom admin (the human or app on the support side). */
export interface IntercomAdmin {
  id: string;
  name?: string | null;
  email?: string | null;
}

export type IntercomConversationState = "open" | "closed" | "snoozed";

/**
 * One Intercom conversation. Slim shape: the v0.1 connector only renders
 * the source body, the contact, the assignee, and the state. The full
 * payload from the API has many more fields (custom attributes, AI
 * summaries, message routing metadata) that we deliberately don't touch
 * yet — they'd commit us to a richer event model than the v0.1 episode
 * contract is ready for.
 */
export interface IntercomConversation {
  id: string;
  /** ISO-8601 (the API returns Unix epoch seconds; the client converts). */
  created_at: string;
  updated_at: string;
  state: IntercomConversationState;
  priority?: "priority" | "not_priority";
  tags?: ReadonlyArray<string>;
  /** Plaintext body of the conversation's opening message. */
  source_body?: string;
  /** Subject line — only set for email-originated conversations. */
  source_subject?: string | null;
  /** First contact attached to the conversation, when present. */
  contact?: IntercomContact;
  /** Admin currently assigned, when present. */
  assignee_admin_id?: string | null;
  team_assignee_id?: string | null;
}

/**
 * A single conversation-part — the unit Intercom emits for each reply,
 * note, assignment change, etc. v0.1 only emits episodes for "comment"
 * (replies) and "note" (admin internal notes); everything else is
 * dropped at the mapper level.
 */
export interface IntercomConversationPart {
  id: string;
  /** Discriminator: "comment", "note", "assignment", "close", "open",
   * "snoozed", "unsnoozed", "away_mode_assignment", … */
  part_type: string;
  /** Plaintext body. May be empty for system parts. */
  body?: string | null;
  created_at: string;
  /** "admin" or "user" / "lead" / "bot". */
  author_type?: string;
  author_id?: string | null;
  author_name?: string | null;
}

/**
 * Discriminated union the mapper consumes. The sync layer fans out
 * conversations → parts and emits one event per logical episode.
 */
export type IntercomEvent =
  | { type: "conversation.created"; conversation: IntercomConversation }
  | { type: "conversation.closed"; conversation: IntercomConversation }
  | {
      type: "conversation.part";
      conversation: IntercomConversation;
      part: IntercomConversationPart;
    };
