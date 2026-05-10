// Zendesk webhook payload types. Zendesk delivers webhooks in two
// distinct shapes; the receiver accepts both:
//
// 1. **Trigger / Automation–driven** (most common today): the operator
//    creates a Trigger or Automation in Zendesk Admin, adds a "Notify
//    active webhook" action, and writes the JSON body in Zendesk's
//    Liquid templating language. The shape is whatever the operator
//    wrote; we publish a canonical schema in the package README that
//    mirrors `FreshdeskWebhookPayload` (a top-level `event` field for
//    discrimination plus a `ticket` block).
//
// 2. **Event-driven webhook subscription** (Events API): the operator
//    creates a webhook subscription against one or more event types
//    (`zen:event-type:ticket.created`, `zen:event-type:comment.created`,
//    etc.) without writing a Liquid template. Zendesk delivers a stable
//    envelope: `{ type: "zen:event-type:...", event: { ... }, ... }`.
//
// We decouple our discriminator from Zendesk's by mapping both shapes
// down to the same `ZendeskEvent` discriminated union the mapper
// already consumes. The `mapInboundEvent` step in `webhook.ts` is the
// single place that knows about both schemas.

/**
 * Trigger / Automation–driven payload. Same shape as Freshdesk's
 * webhook payload — the operator writes a JSON body for each rule with
 * a top-level `event` discriminator, a stable id for dedup, and the
 * relevant ticket / comment blocks.
 */
export interface ZendeskTriggerWebhookPayload {
  event: ZendeskTriggerEvent | string;
  /**
   * Stable id for retry dedup. Operators construct this in Liquid as
   * `{{ticket.id}}_{{ticket.updated_at_with_timestamp}}` (for ticket
   * events) or `{{ticket.id}}_comment_{{ticket.latest_comment.id}}`.
   * Optional — synthesized from ticket id + updated_at + event when
   * absent.
   */
  event_id?: string;
  ticket: ZendeskWebhookTicket;
  comment?: ZendeskWebhookComment;
}

export type ZendeskTriggerEvent =
  | "ticket.created"
  | "ticket.updated"
  | "ticket.solved"
  | "comment.created";

export interface ZendeskWebhookTicket {
  id: number;
  subject?: string | null;
  description?: string | null;
  /** Zendesk uses string statuses, not numeric codes — pass them through
   * verbatim. The mapper lowercases on read. */
  status?: string | null;
  priority?: string | null;
  type?: string | null;
  tags?: ReadonlyArray<string>;
  requester_id?: number | null;
  assignee_id?: number | null;
  organization_id?: number | null;
  brand_id?: number | null;
  group_id?: number | null;
  created_at: string;
  updated_at: string;
  /** API URL Zendesk sets on the ticket. Used as a fallback permalink
   * when no `subdomain` is configured on the handler. */
  url?: string;
}

export interface ZendeskWebhookComment {
  id: number;
  /** True for public replies, false for agent-only internal notes. */
  public: boolean;
  body?: string | null;
  author_id?: number | null;
  created_at: string;
  via?: { channel?: string };
}

/**
 * Event-driven webhook subscription envelope. Zendesk's stable shape —
 * same envelope for every event type, with a `type` discriminator that
 * uses Zendesk's namespaced ids (`zen:event-type:ticket.created`).
 */
export interface ZendeskEventWebhookPayload {
  /** Zendesk's stable event id — used for dedup. */
  id?: string;
  /** Namespaced type, e.g. `zen:event-type:ticket.created`. */
  type: string;
  /** ISO timestamp when Zendesk fired the event. */
  time?: string;
  /** Account context (subdomain). */
  zendesk_event_version?: string;
  account_id?: number;
  subject?: string;
  /**
   * The event-specific payload. Shape depends on the event type. For
   * ticket events it's a `{ ticket: {...} }`-shaped block; for comment
   * events it's `{ ticket: {...}, comment: {...} }`. We accept the
   * union and dispatch in code rather than in the type system.
   */
  event: {
    ticket?: ZendeskWebhookTicket;
    comment?: ZendeskWebhookComment;
    /** Some event types deliver only ids; we surface what's there and
     * fall back to a `ticket:<id>` subject when full ticket data is
     * missing. */
    ticket_id?: number;
    comment_id?: number;
  };
}

/** Discriminator helper — tells the trigger and event-driven shapes apart. */
export function isEventDrivenPayload(
  payload: unknown,
): payload is ZendeskEventWebhookPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { type?: unknown }).type === "string" &&
    ((payload as { type: string }).type.startsWith("zen:event-type:") ||
      (payload as { type: string }).type.startsWith("zen:event:"))
  );
}
