// Inbound Jira Cloud webhook callback shapes (the subset we consume).
//
// Jira Cloud admin webhooks POST a JSON body with a `webhookEvent` discriminator
// plus the raw `issue` (and, for comment events, `comment`) objects — the same
// `fields` shape the REST API returns, so we reuse the connector's normalizers.
//
// Event values (see developer.atlassian.com/cloud/jira/platform/webhooks):
//   jira:issue_created | jira:issue_updated | jira:issue_deleted
//   comment_created | comment_updated | comment_deleted

import type { RawChangelog, RawComment, RawIssue, RawUser } from "./client.js";

export type JiraWebhookEventName =
  | "jira:issue_created"
  | "jira:issue_updated"
  | "jira:issue_deleted"
  | "comment_created"
  | "comment_updated"
  | "comment_deleted";

export interface JiraWebhookPayload {
  /** Epoch-millis event time Jira stamps on the callback. */
  timestamp?: number;
  /** Discriminator, e.g. `jira:issue_created`. */
  webhookEvent?: string;
  /** Finer-grained issue event name, e.g. `issue_generic`, `issue_commented`. */
  issue_event_type_name?: string;
  /** The actor who triggered the event (no email is ever read). */
  user?: RawUser;
  /** Raw issue (same `fields` shape as the REST API). Present on all events. */
  issue?: RawIssue;
  /** Raw comment — present on `comment_*` events. */
  comment?: RawComment;
  /** Single-change changelog — present on `jira:issue_updated`. */
  changelog?: RawChangelog;
}
