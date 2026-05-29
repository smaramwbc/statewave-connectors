export type GiteaEventKind =
  | "gitea.issue.opened"
  | "gitea.issue.closed"
  | "gitea.issue.comment"
  | "gitea.pr.opened"
  | "gitea.pr.closed"
  | "gitea.pr.merged"
  | "gitea.pr.comment"
  | "gitea.pr.review"
  | "gitea.release.published";

export interface GiteaUser {
  login: string;
  id?: number;
}

export interface GiteaLabel {
  name: string;
}

export interface GiteaMilestone {
  title: string;
  id?: number;
}

export interface GiteaIssue {
  type: "issue";
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  user: GiteaUser | null;
  labels: ReadonlyArray<GiteaLabel>;
  milestone?: GiteaMilestone | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
}

export interface GiteaPullRequest {
  type: "pull_request";
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  merged: boolean;
  user: GiteaUser | null;
  labels: ReadonlyArray<GiteaLabel>;
  milestone?: GiteaMilestone | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  base?: { ref: string };
  head?: { ref: string };
}

export interface GiteaComment {
  type: "comment";
  parent: "issue" | "pull_request";
  parent_number: number;
  id: number;
  body: string;
  user: GiteaUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GiteaReview {
  type: "review";
  pr_number: number;
  id: number;
  user: GiteaUser | null;
  state: "APPROVED" | "REQUEST_CHANGES" | "COMMENT" | "PENDING" | "REQUEST_REVIEW" | string;
  body?: string | null;
  html_url: string;
  submitted_at: string;
}

export interface GiteaRelease {
  type: "release";
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  author: GiteaUser | null;
  html_url: string;
  published_at: string;
}

export type GiteaEvent =
  | GiteaIssue
  | GiteaPullRequest
  | GiteaComment
  | GiteaReview
  | GiteaRelease;

export interface GiteaRepoRef {
  owner: string;
  name: string;
}
