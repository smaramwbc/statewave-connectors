// Freshdesk-event → Statewave-episode mapping. Side-effect-free; the
// connector resolves tickets, conversations, requester, and (best-effort)
// company before calling this so the mapper itself is a pure
// transformation.

import { EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type {
  FreshdeskCompany,
  FreshdeskConversation,
  FreshdeskEvent,
  FreshdeskEventKind,
  FreshdeskTicket,
  FreshdeskUser,
} from "./types.js";

export interface MapperOptions {
  /** Override for the auto-derived subject. */
  subject?: string;
  /** Subdomain — used to mint browser permalinks like
   * `https://acme.freshdesk.com/a/tickets/123`. Optional. */
  subdomain?: string;
}

/**
 * Subject default: company id when the ticket has one (B2B accounts),
 * else the requester id (B2C / single-tenant). Both render as
 * `customer:<id>` so consumers don't have to special-case which axis
 * the ticket happened to ride on. Pathological tickets with neither
 * (rare) fall back to the ticket id so episodes still group somewhere.
 */
export function defaultSubject(ticket: FreshdeskTicket): string {
  if (ticket.company_id) return `customer:${ticket.company_id}`;
  if (ticket.requester_id) return `customer:${ticket.requester_id}`;
  return `ticket:${ticket.id}`;
}

export function mapFreshdeskEvent(
  event: FreshdeskEvent,
  options: MapperOptions = {},
): StatewaveEpisode {
  if (event.type === "conversation") {
    return mapConversation(
      event.ticket,
      event.conversation,
      options,
      event.requester,
      event.company,
    );
  }
  if (event.type === "ticket.resolved") {
    return mapTicketResolved(event.ticket, options, event.requester, event.company);
  }
  return mapTicketCreated(event.ticket, options, event.requester, event.company);
}

function mapTicketCreated(
  ticket: FreshdeskTicket,
  options: MapperOptions,
  requester?: FreshdeskUser,
  company?: FreshdeskCompany,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(ticket);
  const requesterLabel = resolveRequesterLabel(requester, ticket);
  const subjectLine = (ticket.subject ?? "").trim() || "(no subject)";
  const description = (ticket.description_text ?? "").trim();
  const text = description
    ? `${requesterLabel} opened ticket #${ticket.id} — ${subjectLine}: ${description}`
    : `${requesterLabel} opened ticket #${ticket.id} — ${subjectLine}`;

  return buildEpisode({
    kind: "freshdesk.ticket.created",
    subject,
    text,
    occurred_at: ticket.created_at,
    sourceType: "freshdesk.ticket",
    sourceId: `ticket:${ticket.id}`,
    sourceUrl: ticketUrl(ticket, options.subdomain),
    ticket,
    company,
    extraMetadata: {
      requester_id: ticket.requester_id ?? null,
      requester_label: requesterLabel,
      requester_email: requester?.email ?? null,
    },
    idempotencyParts: ["freshdesk", String(ticket.id), "created"],
  });
}

function mapTicketResolved(
  ticket: FreshdeskTicket,
  options: MapperOptions,
  requester?: FreshdeskUser,
  company?: FreshdeskCompany,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(ticket);
  const subjectLine = (ticket.subject ?? "").trim() || "(no subject)";
  const verb = ticket.status === "closed" ? "closed" : "resolved";
  const text = `Ticket #${ticket.id} ${verb} — ${subjectLine}`;

  return buildEpisode({
    kind: "freshdesk.ticket.resolved",
    subject,
    text,
    // Freshdesk doesn't expose an exact "resolved_at" without diff'ing
    // snapshots — updated_at is the best-available proxy. Operators
    // who need precise resolution time should pair this with audit logs.
    occurred_at: ticket.updated_at,
    sourceType: "freshdesk.ticket.resolution",
    sourceId: `ticket:${ticket.id}:resolution`,
    sourceUrl: ticketUrl(ticket, options.subdomain),
    ticket,
    company,
    extraMetadata: {
      requester_id: ticket.requester_id ?? null,
      requester_label: resolveRequesterLabel(requester, ticket),
      requester_email: requester?.email ?? null,
    },
    idempotencyParts: ["freshdesk", String(ticket.id), "resolved", ticket.status ?? "unknown"],
  });
}

function mapConversation(
  ticket: FreshdeskTicket,
  conversation: FreshdeskConversation,
  options: MapperOptions,
  requester?: FreshdeskUser,
  company?: FreshdeskCompany,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(ticket);
  const isPrivate = conversation.private;
  const kind: FreshdeskEventKind = isPrivate
    ? "freshdesk.conversation.internal_note"
    : "freshdesk.conversation.posted";
  const authorLabel = resolveConversationAuthorLabel(conversation, requester);
  const channelHint = conversation.source != null ? ` via ${channelLabelForSource(conversation.source)}` : "";
  const noteHint = isPrivate ? " (internal note)" : "";
  const body = (conversation.body_text ?? "").trim();
  const text = body
    ? `${authorLabel}${channelHint}${noteHint} on ticket #${ticket.id}: ${body}`
    : `${authorLabel}${channelHint}${noteHint} on ticket #${ticket.id}`;

  return buildEpisode({
    kind,
    subject,
    text,
    occurred_at: conversation.created_at,
    sourceType: isPrivate ? "freshdesk.internal_note" : "freshdesk.conversation",
    sourceId: `ticket:${ticket.id}:conversation:${conversation.id}`,
    sourceUrl: ticketUrl(ticket, options.subdomain),
    ticket,
    company,
    extraMetadata: {
      conversation_id: conversation.id,
      author_id: conversation.user_id ?? null,
      author_label: authorLabel,
      via_channel: conversation.source != null ? channelLabelForSource(conversation.source) : null,
      private: isPrivate,
      incoming: conversation.incoming ?? null,
    },
    idempotencyParts: ["freshdesk", String(ticket.id), "conversation", String(conversation.id), kind],
  });
}

function buildEpisode(args: {
  kind: FreshdeskEventKind;
  subject: string;
  text: string;
  occurred_at: string;
  sourceType: string;
  sourceId: string;
  sourceUrl?: string;
  ticket: FreshdeskTicket;
  company?: FreshdeskCompany;
  extraMetadata: Record<string, unknown>;
  idempotencyParts: ReadonlyArray<string>;
}): StatewaveEpisode {
  const builder = new EpisodeBuilder({
    subject: args.subject,
    metadata: {
      ticket_id: args.ticket.id,
      ticket_status: args.ticket.status ?? null,
      ticket_status_code: args.ticket.status_code ?? null,
      ticket_priority: args.ticket.priority ?? null,
      ticket_type: args.ticket.type ?? null,
      ticket_tags: args.ticket.tags ?? [],
      responder_id: args.ticket.responder_id ?? null,
      company_id: args.ticket.company_id ?? null,
      company_name: args.company?.name ?? null,
      group_id: args.ticket.group_id ?? null,
      product_id: args.ticket.product_id ?? null,
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

function ticketUrl(ticket: FreshdeskTicket, subdomain?: string): string | undefined {
  if (!subdomain) return undefined;
  return `https://${subdomain}.freshdesk.com/a/tickets/${ticket.id}`;
}

function resolveRequesterLabel(
  requester: FreshdeskUser | undefined,
  ticket: FreshdeskTicket,
): string {
  if (requester?.name) return requester.name;
  if (requester?.email) return requester.email;
  if (ticket.requester_id) return `requester:${ticket.requester_id}`;
  return "unknown requester";
}

function resolveConversationAuthorLabel(
  conversation: FreshdeskConversation,
  requester?: FreshdeskUser,
): string {
  // Same shape as Zendesk: we only fetch the requester directory for
  // metadata; per-author lookups would multiply API calls. If the author
  // happens to be the requester we already resolved, render their name.
  if (conversation.user_id && requester?.id === conversation.user_id) {
    if (requester.name) return requester.name;
    if (requester.email) return requester.email;
  }
  if (conversation.user_id) return `user:${conversation.user_id}`;
  return "unknown author";
}

/**
 * Map Freshdesk's numeric `source` field on a conversation entry to a
 * human label. Values follow Freshdesk's documented table; we render
 * unknowns as `source:<n>` so episodes don't lose information.
 */
function channelLabelForSource(source: number): string {
  switch (source) {
    case 1:
      return "email";
    case 2:
      return "portal";
    case 3:
      return "phone";
    case 5:
      return "chat";
    case 6:
      return "mobihelp";
    case 7:
      return "feedback_widget";
    case 8:
      return "outbound_email";
    case 9:
      return "ecommerce";
    default:
      return `source:${source}`;
  }
}
