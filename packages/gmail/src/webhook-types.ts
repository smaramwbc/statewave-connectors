// Gmail Pub/Sub push payload types.
//
// Gmail's "watch" API publishes a tiny payload — `{ emailAddress,
// historyId }` — to a Cloud Pub/Sub topic whenever the user's mailbox
// changes. The Pub/Sub push subscription then POSTs that message to a
// configured URL, wrapping it in the standard Pub/Sub push envelope:
//
// {
//   "message": {
//     "data": "<base64 of the gmail payload JSON>",
//     "messageId": "...",
//     "publishTime": "...",
//     "attributes": { ... }
//   },
//   "subscription": "projects/.../subscriptions/..."
// }
//
// The receiver decodes `data` into a `GmailWatchPayload`, then walks
// the Gmail History API from the last-seen historyId forward to fetch
// the actual messages that triggered the notification. Pub/Sub itself
// doesn't include the messages — only a "the mailbox changed" pointer.

/** Pub/Sub push delivery envelope. Standard across all Google Cloud push subscriptions. */
export interface PubsubPushEnvelope {
  message: {
    /** Base64-encoded payload bytes. For Gmail this decodes to a JSON
     * `GmailWatchPayload`. */
    data?: string;
    /** Pub/Sub's stable id for the message — used for dedup across retries. */
    messageId?: string;
    /** ISO-8601 timestamp of when the message was first published. */
    publishTime?: string;
    /** Operator-supplied attributes on the original publish. Gmail
     * doesn't use these; we surface them for diagnostic logging. */
    attributes?: Record<string, string>;
  };
  /** Resource name of the subscription that delivered this message,
   * e.g. `projects/my-project/subscriptions/gmail-push`. */
  subscription?: string;
}

/**
 * The decoded Gmail watch payload. Tiny by design — all the receiver
 * needs is the user's email address (so it can scope cursor state) and
 * the latest history id (so it can fetch deltas via the History API).
 */
export interface GmailWatchPayload {
  /** The user whose mailbox just changed. */
  emailAddress: string;
  /** Latest historyId at publish time. The receiver lists everything
   * between the last-persisted historyId and this one. */
  historyId: string | number;
}
