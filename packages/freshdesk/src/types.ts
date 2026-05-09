// Public types for the Freshdesk connector. Models the slice of
// Freshdesk's REST API the v0.1 pull connector reads — tickets + their
// conversation thread (replies and agent notes). Surveys, time entries,
// the Solutions/Articles surface, and webhook delivery are all out of
// scope here; each warrants its own event kinds.

export type FreshdeskEventKind =
  | "freshdesk.ticket.created"
  | "freshdesk.ticket.resolved"
  | "freshdesk.conversation.posted"
  | "freshdesk.conversation.internal_note";

/**
 * Freshdesk ticket statuses are numeric on the wire. The connector
 * normalizes them to typed strings so episode metadata is readable
 * without operators having to memorize the integer table. Custom
 * statuses configured per-account land in `custom`.
 */
export type FreshdeskTicketStatus =
  | "open"
  | "pending"
  | "resolved"
  | "closed"
  | "waiting_on_customer"
  | "waiting_on_third_party"
  | "custom";

/**
 * Numeric → string mapping. The four built-in statuses are stable
 * across all Freshdesk accounts; 5 + 6 are typically "Waiting on …"
 * but accounts can rename them, so we keep the spirit of the label.
 * Anything outside this table maps to "custom".
 */
export const FRESHDESK_STATUS_BY_CODE: Readonly<Record<number, FreshdeskTicketStatus>> = {
  2: "open",
  3: "pending",
  4: "resolved",
  5: "closed",
  6: "waiting_on_customer",
  7: "waiting_on_third_party",
};

/** A Freshdesk requester (the human who opened the ticket). */
export interface FreshdeskUser {
  id: number;
  name?: string | null;
  email?: string | null;
  company_id?: number | null;
}

/** A Freshdesk company (B2B account the requester belongs to). */
export interface FreshdeskCompany {
  id: number;
  name?: string | null;
}

/** A Freshdesk ticket — the slice the v0.1 connector renders. */
export interface FreshdeskTicket {
  id: number;
  subject?: string | null;
  /** First-message body (plaintext). Freshdesk stores this on the
   * ticket itself, so a tickets-only sync still has the original
   * problem statement. */
  description_text?: string | null;
  status?: FreshdeskTicketStatus;
  /** Raw status code. Useful when the normalized status maps to "custom"
   * and operators want to route on the integer. */
  status_code?: number;
  priority?: number | null;
  type?: string | null;
  tags?: ReadonlyArray<string>;
  requester_id?: number | null;
  responder_id?: number | null;
  company_id?: number | null;
  group_id?: number | null;
  product_id?: number | null;
  created_at: string;
  updated_at: string;
}

/** A Freshdesk ticket conversation entry — a reply or an agent note. */
export interface FreshdeskConversation {
  id: number;
  ticket_id: number;
  /** True for agent-only internal notes, false for public replies. */
  private: boolean;
  body_text?: string | null;
  /** Author of this conversation entry (null for system messages). */
  user_id?: number | null;
  /** True when authored by the original requester (vs an agent). */
  incoming?: boolean;
  /** Channel the reply came through — "email", "portal", "phone", etc. */
  source?: number | null;
  created_at: string;
}

/**
 * Discriminated union the mapper consumes. The sync layer fans out
 * tickets → conversations and emits one event per logical episode.
 */
export type FreshdeskEvent =
  | {
      type: "ticket.created";
      ticket: FreshdeskTicket;
      requester?: FreshdeskUser;
      company?: FreshdeskCompany;
    }
  | {
      type: "ticket.resolved";
      ticket: FreshdeskTicket;
      requester?: FreshdeskUser;
      company?: FreshdeskCompany;
    }
  | {
      type: "conversation";
      ticket: FreshdeskTicket;
      conversation: FreshdeskConversation;
      requester?: FreshdeskUser;
      company?: FreshdeskCompany;
    };
