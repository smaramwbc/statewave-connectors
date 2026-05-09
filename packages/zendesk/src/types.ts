// Public types for the Zendesk connector. Models the slice of Zendesk's
// REST API the v0.1 pull connector reads — tickets + their comments.
// Search, sidebar/macro events, and the realtime Conversations API are
// deliberately out of scope; they each warrant their own event kinds and
// auth surface.

export type ZendeskEventKind =
  | "zendesk.ticket.created"
  | "zendesk.ticket.solved"
  | "zendesk.comment.posted"
  | "zendesk.comment.internal_note";

/**
 * Zendesk auth comes in two flavors. Both modes hit the same REST API; the
 * only difference is the `Authorization` header the client emits.
 *
 * - `api_token` is the most common path: an admin generates an API token in
 *   the Zendesk UI and pairs it with a user email. The header becomes
 *   `Basic base64("<email>/token:<api_token>")`.
 * - `oauth` is the path for operators who already have an issued OAuth 2.0
 *   access token (often via a Zendesk app). The header becomes
 *   `Bearer <access_token>`. The connector itself never runs the OAuth
 *   dance — that's an authorization concern, not an ingestion concern.
 */
export type ZendeskAuth =
  | { mode: "api_token"; email: string; apiToken: string }
  | { mode: "oauth"; accessToken: string };

/** A Zendesk requester (the human who opened the ticket). */
export interface ZendeskUser {
  id: number;
  name?: string;
  email?: string;
  organization_id?: number | null;
}

/** A Zendesk organization (the company the requester belongs to, B2B). */
export interface ZendeskOrganization {
  id: number;
  name?: string;
}

/**
 * A single Zendesk ticket. The connector flattens the slice of fields it
 * needs into this shape — the raw API payload has many more, but we keep
 * the surface tight to make mapping deterministic.
 */
export interface ZendeskTicket {
  id: number;
  subject?: string;
  /** First-comment body. Zendesk stores this on the ticket itself, so a
   * tickets-only sync (no `--include comments`) still has a meaningful
   * problem statement. */
  description?: string;
  status?: ZendeskTicketStatus;
  priority?: string | null;
  type?: string | null;
  tags?: ReadonlyArray<string>;
  requester_id?: number;
  assignee_id?: number | null;
  organization_id?: number | null;
  brand_id?: number | null;
  group_id?: number | null;
  created_at: string;
  updated_at: string;
  url?: string;
}

export type ZendeskTicketStatus =
  | "new"
  | "open"
  | "pending"
  | "hold"
  | "solved"
  | "closed";

/** A single Zendesk ticket comment. Comments are always per-ticket. */
export interface ZendeskComment {
  id: number;
  ticket_id: number;
  /** True for public replies, false for agent-only internal notes. */
  public: boolean;
  body?: string;
  /** May be null for system events. */
  author_id?: number | null;
  created_at: string;
  via?: { channel?: string };
}

/**
 * Discriminated union the mapper consumes. The sync layer fans out tickets
 * → comments and emits one event per logical episode the connector wants
 * to ingest.
 */
export type ZendeskEvent =
  | { type: "ticket.created"; ticket: ZendeskTicket; requester?: ZendeskUser; organization?: ZendeskOrganization }
  | { type: "ticket.solved"; ticket: ZendeskTicket; requester?: ZendeskUser; organization?: ZendeskOrganization }
  | { type: "comment"; ticket: ZendeskTicket; comment: ZendeskComment; requester?: ZendeskUser; organization?: ZendeskOrganization };
