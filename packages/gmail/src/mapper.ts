// Gmail-event → Statewave-episode mapping. Side-effect-free; the
// connector resolves messages, extracts bodies from MIME, and
// classifies inbound vs outbound before calling this so the mapper
// itself is a pure transformation.

import { EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type { GmailEvent, GmailEventKind, GmailMessage } from "./types.js";

export interface MapperOptions {
  /** Override for the auto-derived subject. */
  subject?: string;
}

/**
 * Subject default: `relationship:<other_email>`. For received messages
 * the "other party" is the From address; for sent messages it's the
 * first To recipient. Both are lowercased and stripped of any display
 * name before being used as the subject anchor — so `Bob <bob@x>` and
 * `bob@x` route to the same `relationship:bob@x` subject.
 *
 * Pathological messages with no From and no To (rare — system-only
 * mail) fall back to `thread:<thread_id>` so episodes still group
 * coherently.
 */
export function defaultSubject(message: GmailMessage, isSent: boolean): string {
  const candidate = isSent ? firstAddress(message.to) : firstAddress(message.from);
  if (candidate) return `relationship:${candidate}`;
  // Fallback for system-only messages (calendar invites with no human
  // counterparty, mail-from-noreply etc.).
  return `thread:${message.thread_id}`;
}

export function mapGmailEvent(
  event: GmailEvent,
  options: MapperOptions = {},
): StatewaveEpisode {
  const isSent = event.type === "message.sent";
  const message = event.message;
  const subject = options.subject ?? defaultSubject(message, isSent);
  const kind: GmailEventKind = isSent ? "gmail.message.sent" : "gmail.message.received";
  const subjectLine = (message.subject ?? "").trim() || "(no subject)";
  const author = (isSent ? firstAddress(message.from) : firstAddress(message.from)) ?? "unknown";
  const recipient = firstAddress(message.to) ?? "(no recipient)";
  const verb = isSent ? "sent" : "received";
  const headline = isSent
    ? `${verb} email to ${recipient} — ${subjectLine}`
    : `${verb} email from ${author} — ${subjectLine}`;
  const body = (message.body ?? "").trim();
  const text = body ? `${headline}\n\n${body}` : headline;

  const builder = new EpisodeBuilder({
    subject,
    metadata: {
      message_id: message.id,
      thread_id: message.thread_id,
      message_id_header: message.message_id_header ?? null,
      from: message.from ?? null,
      to: message.to ?? null,
      cc: message.cc ?? null,
      subject_line: subjectLine,
      label_ids: message.label_ids,
      direction: isSent ? "sent" : "received",
    },
  });

  return builder.build({
    kind,
    text,
    occurred_at: message.date ? normalizeDate(message.date, message.internal_date) : message.internal_date,
    source: {
      type: isSent ? "gmail.message.sent" : "gmail.message.received",
      id: `message:${message.id}`,
      // Gmail web app permalink. The `users/me` shortcut on the API
      // doesn't translate to the web UI URL, but the message id is the
      // same — the public web URL is derived from the message id.
      url: `https://mail.google.com/mail/u/0/#all/${message.id}`,
    },
    metadata: {
      // Placeholder kept consistent with other mappers — the
      // EpisodeBuilder defaults already carry message-shape metadata.
    },
    // Message id alone is unique within Gmail, but include kind so a
    // hypothetical re-classification (received → sent during a label
    // edit) emits a fresh episode rather than dedup'ing.
    idempotency_parts: ["gmail", message.id, kind],
  });
}

/**
 * Helper for the sync layer: turn a GmailMessage into the appropriate
 * GmailEvent based on whether the `SENT` label is present.
 */
export function classifyMessage(message: GmailMessage): GmailEvent {
  if (message.label_ids.includes("SENT")) {
    return { type: "message.sent", message };
  }
  return { type: "message.received", message };
}

/**
 * Pull the address part out of a header value like
 *   Bob Smith <bob@example.com>
 *   bob@example.com
 *   "Bob, Smith" <bob@example.com>, alice@x.com
 * — taking the first if multiple. Returns lowercased address or
 * undefined when no `@`-bearing token is found.
 */
function firstAddress(header: string | undefined): string | undefined {
  if (!header) return undefined;
  // Prefer the angle-bracket form when present.
  const angle = /<([^<>]+@[^<>]+)>/.exec(header);
  if (angle?.[1]) return angle[1].trim().toLowerCase();
  // Otherwise grab the first comma-separated token that contains an @.
  for (const token of header.split(",")) {
    const t = token.trim();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return t.toLowerCase();
  }
  return undefined;
}

/**
 * Normalize the Date header to ISO-8601. Gmail's Date header is
 * RFC-2822 (e.g. `Mon, 9 May 2026 08:00:00 +0000`); the Date constructor
 * parses that natively. Fall back to internalDate if parsing fails.
 */
function normalizeDate(header: string, fallback: string): string {
  const ms = Date.parse(header);
  if (!Number.isFinite(ms)) return fallback;
  return new Date(ms).toISOString();
}
