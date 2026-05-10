// Freshdesk webhook payload types — what the handler reads off the body.
// Freshdesk's webhook payloads are operator-configured Liquid templates
// (Admin → Workflows → Automations → Webhook step), so the JSON shape
// is whatever the operator wrote. We document a canonical schema in the
// package README and parse defensively — missing optional fields fall
// back to null, never throw.

/**
 * Top-level event discriminator. Operator picks one of these per
 * Freshdesk Automation rule and sends a webhook with the matching
 * `event` field. Anything else is ignored with `unknown_event`.
 */
export type FreshdeskWebhookEvent =
  | "ticket.created"
  | "ticket.updated"
  | "ticket.resolved"
  | "comment.added";

export interface FreshdeskWebhookPayload {
  /** Discriminator. Operator sets this per-automation. */
  event: FreshdeskWebhookEvent | string;
  /**
   * Stable id for retry dedup. Freshdesk doesn't generate this natively;
   * operators construct it from Liquid templates such as
   * `{{ticket.id}}_{{ticket.updated_at}}` (for ticket events) or
   * `{{ticket.id}}_comment_{{conversation.id}}` (for comment events).
   * Optional — if missing, we synthesize one from the ticket id +
   * timestamp + comment id (when present).
   */
  event_id?: string;
  ticket: FreshdeskWebhookTicket;
  /** Present on comment.added events. */
  comment?: FreshdeskWebhookComment;
}

export interface FreshdeskWebhookTicket {
  id: number;
  subject?: string | null;
  description_text?: string | null;
  /** Numeric status code (2=Open, 3=Pending, 4=Resolved, 5=Closed,
   * 6=Waiting on Customer, 7=Waiting on Third Party). The handler
   * normalizes these to typed strings via the same table the pull
   * connector uses. */
  status?: number | null;
  priority?: number | null;
  type?: string | null;
  tags?: ReadonlyArray<string>;
  requester_id?: number | null;
  responder_id?: number | null;
  company_id?: number | null;
  group_id?: number | null;
  product_id?: number | null;
  brand_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface FreshdeskWebhookComment {
  id: number;
  /** True for agent-only internal notes, false for public replies. */
  private: boolean;
  body_text?: string | null;
  user_id?: number | null;
  /** Channel the reply came through (Freshdesk's numeric `source` table). */
  source?: number | null;
  created_at: string;
}
