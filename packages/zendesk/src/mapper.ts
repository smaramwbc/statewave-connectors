// Zendesk-event → Statewave-episode mapping. Side-effect-free; the
// connector resolves tickets, comments, and (best-effort) the requester +
// org before calling this so the mapper itself is a pure transformation.

import { EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type {
  ZendeskComment,
  ZendeskEvent,
  ZendeskEventKind,
  ZendeskOrganization,
  ZendeskTicket,
  ZendeskUser,
} from "./types.js";

export interface MapperOptions {
  /** Override for the auto-derived subject. */
  subject?: string;
  /** Subdomain — used to mint browser permalinks like
   * `https://acme.zendesk.com/agent/tickets/123`. Optional: if omitted,
   * episodes carry the API URL Zendesk returned on the ticket. */
  subdomain?: string;
}

/**
 * Subject default: organization id when the ticket has one (B2B accounts),
 * else the requester id (B2C / single-tenant). Both render as
 * `customer:<id>` so consumers don't need to special-case which axis the
 * ticket happened to ride on.
 */
export function defaultSubject(
  ticket: ZendeskTicket,
): string {
  if (ticket.organization_id) return `customer:${ticket.organization_id}`;
  if (ticket.requester_id) return `customer:${ticket.requester_id}`;
  // Pathological ticket with neither — fall back to ticket id so episodes
  // still group somewhere sensible.
  return `ticket:${ticket.id}`;
}

export function mapZendeskEvent(
  event: ZendeskEvent,
  options: MapperOptions = {},
): StatewaveEpisode {
  if (event.type === "comment") {
    return mapComment(event.ticket, event.comment, options, event.requester, event.organization);
  }
  if (event.type === "ticket.solved") {
    return mapTicketSolved(event.ticket, options, event.requester, event.organization);
  }
  return mapTicketCreated(event.ticket, options, event.requester, event.organization);
}

function mapTicketCreated(
  ticket: ZendeskTicket,
  options: MapperOptions,
  requester?: ZendeskUser,
  organization?: ZendeskOrganization,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(ticket);
  const requesterLabel = resolveRequesterLabel(requester, ticket);
  const subjectLine = ticket.subject?.trim() || "(no subject)";
  const description = ticket.description?.trim() ?? "";
  const text = description
    ? `${requesterLabel} opened ticket #${ticket.id} — ${subjectLine}: ${description}`
    : `${requesterLabel} opened ticket #${ticket.id} — ${subjectLine}`;

  return buildEpisode({
    kind: "zendesk.ticket.created",
    subject,
    text,
    occurred_at: ticket.created_at,
    sourceType: "zendesk.ticket",
    sourceId: `ticket:${ticket.id}`,
    sourceUrl: ticketUrl(ticket, options.subdomain),
    ticket,
    organization,
    extraMetadata: {
      requester_id: ticket.requester_id ?? null,
      requester_label: requesterLabel,
      requester_email: requester?.email ?? null,
    },
    idempotencyParts: ["zendesk", String(ticket.id), "created"],
  });
}

function mapTicketSolved(
  ticket: ZendeskTicket,
  options: MapperOptions,
  requester?: ZendeskUser,
  organization?: ZendeskOrganization,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(ticket);
  const subjectLine = ticket.subject?.trim() || "(no subject)";
  const verb = ticket.status === "closed" ? "closed" : "marked solved";
  const text = `Ticket #${ticket.id} ${verb} — ${subjectLine}`;

  return buildEpisode({
    kind: "zendesk.ticket.solved",
    subject,
    text,
    // Zendesk doesn't tell us *exactly* when the ticket transitioned to
    // solved without diff'ing snapshots, so we use updated_at as the
    // best-available proxy. Operators who need precise resolution time
    // should pair this with audit logs.
    occurred_at: ticket.updated_at,
    sourceType: "zendesk.ticket.resolution",
    sourceId: `ticket:${ticket.id}:resolution`,
    sourceUrl: ticketUrl(ticket, options.subdomain),
    ticket,
    organization,
    extraMetadata: {
      requester_id: ticket.requester_id ?? null,
      requester_label: resolveRequesterLabel(requester, ticket),
      requester_email: requester?.email ?? null,
    },
    idempotencyParts: ["zendesk", String(ticket.id), "solved", ticket.status ?? "unknown"],
  });
}

function mapComment(
  ticket: ZendeskTicket,
  comment: ZendeskComment,
  options: MapperOptions,
  requester?: ZendeskUser,
  organization?: ZendeskOrganization,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(ticket);
  const kind: ZendeskEventKind = comment.public
    ? "zendesk.comment.posted"
    : "zendesk.comment.internal_note";
  const authorLabel = resolveCommentAuthorLabel(comment, requester);
  const channelHint = comment.via?.channel ? ` via ${comment.via.channel}` : "";
  const noteHint = comment.public ? "" : " (internal note)";
  const body = comment.body?.trim() ?? "";
  const text = body
    ? `${authorLabel}${channelHint}${noteHint} on ticket #${ticket.id}: ${body}`
    : `${authorLabel}${channelHint}${noteHint} on ticket #${ticket.id}`;

  return buildEpisode({
    kind,
    subject,
    text,
    occurred_at: comment.created_at,
    sourceType: comment.public ? "zendesk.comment" : "zendesk.internal_note",
    sourceId: `ticket:${ticket.id}:comment:${comment.id}`,
    sourceUrl: ticketUrl(ticket, options.subdomain),
    ticket,
    organization,
    extraMetadata: {
      comment_id: comment.id,
      author_id: comment.author_id ?? null,
      author_label: authorLabel,
      via_channel: comment.via?.channel ?? null,
      public: comment.public,
    },
    idempotencyParts: ["zendesk", String(ticket.id), "comment", String(comment.id), kind],
  });
}

function buildEpisode(args: {
  kind: ZendeskEventKind;
  subject: string;
  text: string;
  occurred_at: string;
  sourceType: string;
  sourceId: string;
  sourceUrl?: string;
  ticket: ZendeskTicket;
  organization?: ZendeskOrganization;
  extraMetadata: Record<string, unknown>;
  idempotencyParts: ReadonlyArray<string>;
}): StatewaveEpisode {
  const builder = new EpisodeBuilder({
    subject: args.subject,
    metadata: {
      ticket_id: args.ticket.id,
      ticket_status: args.ticket.status ?? null,
      ticket_priority: args.ticket.priority ?? null,
      ticket_type: args.ticket.type ?? null,
      ticket_tags: args.ticket.tags ?? [],
      assignee_id: args.ticket.assignee_id ?? null,
      organization_id: args.ticket.organization_id ?? null,
      organization_name: args.organization?.name ?? null,
      brand_id: args.ticket.brand_id ?? null,
      group_id: args.ticket.group_id ?? null,
    },
  });

  return builder.build({
    kind: args.kind,
    text: args.text,
    occurred_at: args.occurred_at,
    source: {
      type: args.sourceType,
      id: args.sourceId,
      url: args.sourceUrl,
    },
    metadata: args.extraMetadata,
    idempotency_parts: [...args.idempotencyParts],
  });
}

function ticketUrl(ticket: ZendeskTicket, subdomain?: string): string | undefined {
  if (subdomain) return `https://${subdomain}.zendesk.com/agent/tickets/${ticket.id}`;
  return ticket.url;
}

function resolveRequesterLabel(
  requester: ZendeskUser | undefined,
  ticket: ZendeskTicket,
): string {
  if (requester?.name) return requester.name;
  if (requester?.email) return requester.email;
  if (ticket.requester_id) return `requester:${ticket.requester_id}`;
  return "unknown requester";
}

function resolveCommentAuthorLabel(
  comment: ZendeskComment,
  requester?: ZendeskUser,
): string {
  // The comment author may or may not be the original requester; we only
  // get a friendly name back when the requester directory happens to cover
  // them. The connector deliberately does not chase per-author lookups in
  // v0.1 — it would add an N+1 over comments and most agent pipelines
  // already join author ids client-side.
  if (comment.author_id && requester?.id === comment.author_id) {
    if (requester.name) return requester.name;
    if (requester.email) return requester.email;
  }
  if (comment.author_id) return `user:${comment.author_id}`;
  return "unknown author";
}
