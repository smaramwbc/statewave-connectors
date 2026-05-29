export type BitbucketEventKind =
  | "bitbucket.issue.opened"
  | "bitbucket.issue.closed"
  | "bitbucket.issue.comment"
  | "bitbucket.pr.opened"
  | "bitbucket.pr.closed"
  | "bitbucket.pr.merged"
  | "bitbucket.pr.comment";

export interface BitbucketUser {
  nickname?: string | null;
  display_name?: string | null;
}

export interface BitbucketIssue {
  type: "issue";
  id: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  user: BitbucketUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface BitbucketPullRequest {
  type: "pull_request";
  id: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  merged: boolean;
  declined: boolean;
  user: BitbucketUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  source_branch?: string;
  destination_branch?: string;
}

export interface BitbucketComment {
  type: "comment";
  parent: "pull_request" | "issue";
  parent_id: number;
  id: number;
  body: string;
  user: BitbucketUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export type BitbucketEvent = BitbucketIssue | BitbucketPullRequest | BitbucketComment;

export interface BitbucketRepoRef {
  /** Bitbucket workspace (the `{workspace}` path segment). */
  owner: string;
  /** Bitbucket repository slug (the `{repo_slug}` path segment). */
  name: string;
}
