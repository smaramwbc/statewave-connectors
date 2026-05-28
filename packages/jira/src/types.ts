export type JiraEventKind =
  | "jira.issue.created"
  | "jira.issue.resolved"
  | "jira.comment.created";

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

export type JiraEvent = JiraIssue | JiraComment;
