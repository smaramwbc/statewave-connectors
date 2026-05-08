export type GithubEventKind =
  | "github.issue.opened"
  | "github.issue.closed"
  | "github.issue.comment"
  | "github.pr.opened"
  | "github.pr.closed"
  | "github.pr.merged"
  | "github.pr.comment"
  | "github.pr.review"
  | "github.release.published";

export interface GithubUser {
  login: string;
  id?: number;
}

export interface GithubLabel {
  name: string;
}

export interface GithubMilestone {
  title: string;
  number?: number;
}

export interface GithubIssue {
  type: "issue";
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  user: GithubUser | null;
  labels: ReadonlyArray<GithubLabel>;
  milestone?: GithubMilestone | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
}

export interface GithubPullRequest {
  type: "pull_request";
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  merged: boolean;
  user: GithubUser | null;
  labels: ReadonlyArray<GithubLabel>;
  milestone?: GithubMilestone | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  base?: { ref: string };
  head?: { ref: string };
}

export interface GithubComment {
  type: "comment";
  parent: "issue" | "pull_request";
  parent_number: number;
  id: number;
  body: string;
  user: GithubUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GithubReview {
  type: "review";
  pr_number: number;
  id: number;
  user: GithubUser | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | string;
  body?: string | null;
  html_url: string;
  submitted_at: string;
}

export interface GithubRelease {
  type: "release";
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  author: GithubUser | null;
  html_url: string;
  published_at: string;
}

export type GithubEvent =
  | GithubIssue
  | GithubPullRequest
  | GithubComment
  | GithubReview
  | GithubRelease;

export interface GithubRepoRef {
  owner: string;
  name: string;
}
