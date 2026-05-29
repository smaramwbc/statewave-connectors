export type AzureEventKind =
  | "azure.pr.opened"
  | "azure.pr.closed"
  | "azure.pr.merged"
  | "azure.pr.comment"
  | "azure.pr.review"
  | "azure.workitem.created"
  | "azure.workitem.closed";

export interface AzureUser {
  displayName?: string;
  uniqueName?: string;
}

/** Azure DevOps PR status as returned by the REST API. */
export type AzurePrStatus = "active" | "completed" | "abandoned" | string;

export interface AzureReviewer {
  displayName?: string;
  /** 10=approved, 5=approved with suggestions, 0=none, -5=waiting, -10=rejected */
  vote: number;
}

export interface AzurePullRequest {
  type: "pull_request";
  pullRequestId: number;
  title: string;
  description?: string | null;
  status: AzurePrStatus;
  merged: boolean;
  createdBy: AzureUser | null;
  creationDate: string;
  closedDate?: string | null;
  sourceRefName?: string;
  targetRefName?: string;
  reviewers: ReadonlyArray<AzureReviewer>;
  html_url: string;
}

export interface AzureComment {
  type: "comment";
  pr_id: number;
  thread_id: number;
  id: number;
  content: string;
  author: AzureUser | null;
  publishedDate: string;
  html_url: string;
}

export interface AzureReview {
  type: "review";
  pr_id: number;
  /** Reviewer index within the PR — there is no per-vote id from the API. */
  reviewer_index: number;
  reviewer: AzureUser | null;
  vote: number;
  /** Derived label, e.g. "approved", "rejected". */
  state: string;
  occurred_at: string;
  html_url: string;
}

export interface AzureWorkItem {
  type: "work_item";
  id: number;
  title: string;
  state: string;
  workItemType: string;
  createdBy: AzureUser | null;
  createdDate: string;
  changedDate: string;
  closed: boolean;
  html_url: string;
}

export type AzureEvent = AzurePullRequest | AzureComment | AzureReview | AzureWorkItem;

export interface AzureRepoRef {
  organization: string;
  project: string;
  repository: string;
}
