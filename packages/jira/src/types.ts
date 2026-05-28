export type JiraEventKind =
  | "jira.issue.created"
  | "jira.issue.resolved"
  | "jira.comment.created"
  | "jira.issue.transition";

/** A sprint reference, reduced to the fields worth remembering. */
export interface JiraSprint {
  id?: number;
  name: string;
  state?: string;
  boardId?: number;
}

/**
 * Minimal Atlassian Document Format node. Jira Cloud REST v3 returns rich-text
 * fields (description, comment body) as an ADF document, not plain text. We
 * walk it and concatenate the `text` leaves — see flattenAdf in client.ts.
 */
export interface JiraAdfNode {
  type?: string;
  text?: string;
  content?: ReadonlyArray<JiraAdfNode>;
}

/**
 * A Jira user, reduced to non-PII display fields. We never carry
 * `emailAddress` (often GDPR-hidden anyway) — accountId + displayName only.
 */
export interface JiraUserRef {
  accountId?: string;
  displayName?: string;
}

/** Normalized issue (ADF already flattened to plain text by the client). */
export interface JiraIssue {
  type: "issue";
  key: string;
  projectKey: string;
  summary: string;
  description: string;
  statusName: string;
  /** Jira status category key: "new" | "indeterminate" | "done". */
  statusCategory: string;
  issueType?: string;
  priority?: string;
  labels: ReadonlyArray<string>;
  /** displayName ?? accountId ?? null — never an email. */
  assignee: string | null;
  reporter: string | null;
  created: string;
  updated: string;
  resolutionDate?: string | null;
  /** Opt-in: sprint context, only when `--sprint-field` names the Sprint field. */
  sprints?: ReadonlyArray<JiraSprint>;
  url: string;
}

/**
 * A status transition extracted from an issue's changelog (opt-in). One per
 * status change — `jira.issue.transition`.
 */
export interface JiraTransition {
  type: "transition";
  issueKey: string;
  projectKey: string;
  /** Changelog history id (stable per change) — drives idempotency. */
  changeId: string;
  fromStatus: string | null;
  toStatus: string;
  author: string | null;
  occurredAt: string;
  url: string;
}

/** Normalized comment (ADF already flattened to plain text by the client). */
export interface JiraComment {
  type: "comment";
  id: string;
  issueKey: string;
  projectKey: string;
  author: string | null;
  body: string;
  created: string;
  updated: string;
  url: string;
}

export type JiraEvent = JiraIssue | JiraComment | JiraTransition;
