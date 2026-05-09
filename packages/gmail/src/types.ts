// Public types for the Gmail connector. Models the slice of Google's
// Gmail REST API the v0.1 pull connector reads — message metadata, body
// extraction from MIME parts, and label-based discrimination of
// inbound vs outbound messages. Drafts, threads-as-threads (vs
// per-message), and the History API (delta sync) are deliberately out
// of scope here; each warrants its own event kinds.

export type GmailEventKind =
  | "gmail.message.received"
  | "gmail.message.sent";

/**
 * Gmail OAuth 2.0 refresh-token credentials. The connector exchanges
 * these at runtime for an access token via Google's OAuth endpoint and
 * caches the access token until expiry. Service-account /
 * domain-wide-delegation auth is intentionally deferred to v0.1.1 —
 * it requires JWT signing, which adds a non-trivial dependency, and
 * the refresh-token shape covers the personal/single-user case that
 * v0.1 targets.
 */
export interface GmailOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** A single Gmail message — the slice the v0.1 connector renders. */
export interface GmailMessage {
  id: string;
  thread_id: string;
  /** ISO-8601, derived from `internalDate` (Gmail returns Unix millis). */
  internal_date: string;
  /** Gmail label IDs attached to the message, e.g. `INBOX`, `SENT`,
   * `IMPORTANT`, `STARRED`, plus user-defined labels. */
  label_ids: ReadonlyArray<string>;
  /** Plaintext snippet Gmail provides server-side — usually first ~200
   * chars. We use this if body extraction can't find a text part. */
  snippet?: string;
  /** Headers we surface: From, To, Cc, Subject, Date, Message-ID. */
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  message_id_header?: string;
  /** Plaintext body, extracted from the MIME tree (text/plain preferred;
   * text/html as fallback with tags stripped). May be empty when the
   * message has no text content (e.g. an empty calendar invite). */
  body?: string;
}

/**
 * Discriminated union the mapper consumes. `received` for inbound
 * messages, `sent` for outbound — discriminated at the sync layer by
 * the presence of the `SENT` label.
 */
export type GmailEvent =
  | { type: "message.received"; message: GmailMessage }
  | { type: "message.sent"; message: GmailMessage };
