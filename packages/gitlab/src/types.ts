export type GitlabEventKind =
  | "gitlab.issue.opened"
  | "gitlab.issue.closed"
  | "gitlab.issue.comment"
  | "gitlab.mr.opened"
  | "gitlab.mr.closed"
  | "gitlab.mr.merged"
  | "gitlab.mr.comment"
  | "gitlab.mr.approval"
  | "gitlab.release.published";

export interface GitlabUser {
  username: string;
}

export interface GitlabMilestone {
  title: string;
}

export interface GitlabIssue {
  type: "issue";
  iid: number;
  title: string;
  description?: string | null;
  state: "opened" | "closed";
  author: GitlabUser | null;
  labels: ReadonlyArray<string>;
  milestone?: GitlabMilestone | null;
  web_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
}

export interface GitlabMergeRequest {
  type: "merge_request";
  iid: number;
  title: string;
  description?: string | null;
  state: "opened" | "closed" | "merged" | "locked";
  author: GitlabUser | null;
  labels: ReadonlyArray<string>;
  milestone?: GitlabMilestone | null;
  web_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  source_branch?: string;
  target_branch?: string;
}

export interface GitlabNote {
  type: "note";
  parent: "issue" | "merge_request";
  parent_iid: number;
  parent_web_url: string;
  id: number;
  body: string;
  author: GitlabUser | null;
  created_at: string;
  updated_at: string;
}

export interface GitlabApproval {
  type: "approval";
  mr_iid: number;
  mr_web_url: string;
  approver: string;
  occurred_at: string;
}

export interface GitlabRelease {
  type: "release";
  tag_name: string;
  name?: string | null;
  description?: string | null;
  author: GitlabUser | undefined;
  web_url: string;
  released_at: string;
}

export type GitlabEvent =
  | GitlabIssue
  | GitlabMergeRequest
  | GitlabNote
  | GitlabApproval
  | GitlabRelease;

export interface GitlabRepoRef {
  owner: string;
  name: string;
}
