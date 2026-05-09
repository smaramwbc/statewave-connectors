// Intercom-event → Statewave-episode mapping. Side-effect-free; the
// connector resolves conversations, parts, and (best-effort) the contact
// + primary company before calling this so the mapper itself is a pure
// transformation.

import { EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type {
  IntercomContact,
  IntercomConversation,
  IntercomConversationPart,
  IntercomEvent,
  IntercomEventKind,
  IntercomRegion,
} from "./types.js";

export interface MapperOptions {
  /** Override for the auto-derived subject. */
  subject?: string;
  /** Workspace id (Intercom "app id") — used to mint browser permalinks
   * like `https://app.intercom.com/a/inbox/<app_id>/inbox/conversation/<id>`. */
  appId?: string;
  /** Region — used to pick the right `https://app.<region>.intercom.com` URL. */
  region?: IntercomRegion;
  /** Optional contact directory: lets the sync layer pre-resolve a contact
   * + primary company once and have the mapper render names without a
   * second API call per part. */
  contactDirectory?: ReadonlyMap<string, IntercomContact>;
}

/**
 * Subject default: primary company id when the contact has one (B2B
 * accounts), else the contact id (B2C / single-tenant fallback). Pathological
 * conversations with no contact at all (rare — happens only for app-only
 * automation) fall back to the conversation id so episodes still group
 * somewhere sensible.
 */
export function defaultSubject(
  conversation: IntercomConversation,
  directory?: ReadonlyMap<string, IntercomContact>,
): string {
  const contact = conversation.contact?.id ? directory?.get(conversation.contact.id) ?? conversation.contact : undefined;
  if (contact?.primary_company_id) return `customer:${contact.primary_company_id}`;
  if (contact?.id) return `customer:${contact.id}`;
  return `conversation:${conversation.id}`;
}

export function mapIntercomEvent(
  event: IntercomEvent,
  options: MapperOptions = {},
): StatewaveEpisode {
  if (event.type === "conversation.part") {
    return mapConversationPart(event.conversation, event.part, options);
  }
  if (event.type === "conversation.closed") {
    return mapConversationClosed(event.conversation, options);
  }
  return mapConversationCreated(event.conversation, options);
}

function mapConversationCreated(
  conversation: IntercomConversation,
  options: MapperOptions,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(conversation, options.contactDirectory);
  const contact = resolveContact(conversation, options.contactDirectory);
  const contactLabel = resolveContactLabel(contact, conversation);
  const subjectLine = (conversation.source_subject ?? "").trim();
  const body = (conversation.source_body ?? "").trim();
  const headline = subjectLine
    ? `${contactLabel} opened conversation #${conversation.id} — ${subjectLine}`
    : `${contactLabel} opened conversation #${conversation.id}`;
  const text = body ? `${headline}: ${body}` : headline;

  return buildEpisode({
    kind: "intercom.conversation.created",
    subject,
    text,
    occurred_at: conversation.created_at,
    sourceType: "intercom.conversation",
    sourceId: `conversation:${conversation.id}`,
    sourceUrl: conversationUrl(conversation, options),
    conversation,
    contact,
    extraMetadata: {
      contact_id: contact?.id ?? null,
      contact_label: contactLabel,
      contact_email: contact?.email ?? null,
      contact_external_id: contact?.external_id ?? null,
    },
    idempotencyParts: ["intercom", conversation.id, "created"],
  });
}

function mapConversationClosed(
  conversation: IntercomConversation,
  options: MapperOptions,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(conversation, options.contactDirectory);
  const contact = resolveContact(conversation, options.contactDirectory);
  const subjectLine = (conversation.source_subject ?? "").trim();
  const tail = subjectLine ? ` — ${subjectLine}` : "";
  const text = `Conversation #${conversation.id} closed${tail}`;

  return buildEpisode({
    kind: "intercom.conversation.closed",
    subject,
    text,
    // Intercom doesn't expose an exact "closed_at" without diff'ing
    // snapshots, so updated_at is the best-available proxy. Operators
    // who need precise resolution time should rely on webhooks.
    occurred_at: conversation.updated_at,
    sourceType: "intercom.conversation.resolution",
    sourceId: `conversation:${conversation.id}:resolution`,
    sourceUrl: conversationUrl(conversation, options),
    conversation,
    contact,
    extraMetadata: {
      contact_id: contact?.id ?? null,
      contact_label: resolveContactLabel(contact, conversation),
      contact_email: contact?.email ?? null,
    },
    idempotencyParts: ["intercom", conversation.id, "closed", conversation.state],
  });
}

function mapConversationPart(
  conversation: IntercomConversation,
  part: IntercomConversationPart,
  options: MapperOptions,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(conversation, options.contactDirectory);
  const contact = resolveContact(conversation, options.contactDirectory);
  const isNote = part.part_type === "note";
  const kind: IntercomEventKind = isNote
    ? "intercom.conversation.note_added"
    : "intercom.conversation.replied";
  const authorLabel = part.author_name?.trim() || (part.author_id ? `user:${part.author_id}` : "unknown author");
  const noteHint = isNote ? " (internal note)" : "";
  const body = (part.body ?? "").trim();
  const text = body
    ? `${authorLabel}${noteHint} on conversation #${conversation.id}: ${body}`
    : `${authorLabel}${noteHint} on conversation #${conversation.id}`;

  return buildEpisode({
    kind,
    subject,
    text,
    occurred_at: part.created_at,
    sourceType: isNote ? "intercom.note" : "intercom.reply",
    sourceId: `conversation:${conversation.id}:part:${part.id}`,
    sourceUrl: conversationUrl(conversation, options),
    conversation,
    contact,
    extraMetadata: {
      part_id: part.id,
      part_type: part.part_type,
      author_type: part.author_type ?? null,
      author_id: part.author_id ?? null,
      author_label: authorLabel,
      is_internal_note: isNote,
    },
    idempotencyParts: ["intercom", conversation.id, "part", part.id, kind],
  });
}

function buildEpisode(args: {
  kind: IntercomEventKind;
  subject: string;
  text: string;
  occurred_at: string;
  sourceType: string;
  sourceId: string;
  sourceUrl?: string;
  conversation: IntercomConversation;
  contact?: IntercomContact;
  extraMetadata: Record<string, unknown>;
  idempotencyParts: ReadonlyArray<string>;
}): StatewaveEpisode {
  const builder = new EpisodeBuilder({
    subject: args.subject,
    metadata: {
      conversation_id: args.conversation.id,
      conversation_state: args.conversation.state,
      conversation_priority: args.conversation.priority ?? null,
      conversation_tags: args.conversation.tags ?? [],
      assignee_admin_id: args.conversation.assignee_admin_id ?? null,
      team_assignee_id: args.conversation.team_assignee_id ?? null,
      primary_company_id: args.contact?.primary_company_id ?? null,
      primary_company_name: args.contact?.primary_company_name ?? null,
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

function conversationUrl(
  conversation: IntercomConversation,
  options: MapperOptions,
): string | undefined {
  if (!options.appId) return undefined;
  const region = options.region ?? "us";
  const host = region === "us" ? "app.intercom.com" : `app.${region}.intercom.com`;
  return `https://${host}/a/inbox/${options.appId}/inbox/conversation/${conversation.id}`;
}

function resolveContact(
  conversation: IntercomConversation,
  directory?: ReadonlyMap<string, IntercomContact>,
): IntercomContact | undefined {
  if (!conversation.contact?.id) return conversation.contact;
  return directory?.get(conversation.contact.id) ?? conversation.contact;
}

function resolveContactLabel(
  contact: IntercomContact | undefined,
  conversation: IntercomConversation,
): string {
  if (contact?.name) return contact.name;
  if (contact?.email) return contact.email;
  if (contact?.id) return `contact:${contact.id}`;
  if (conversation.contact?.id) return `contact:${conversation.contact.id}`;
  return "unknown contact";
}
