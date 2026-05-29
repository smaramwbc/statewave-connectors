import { ConnectorError } from "@statewavedev/connectors-core";
import type {
  GitlabApproval,
  GitlabIssue,
  GitlabMergeRequest,
  GitlabNote,
  GitlabRelease,
  GitlabRepoRef,
  GitlabUser,
} from "./types.js";

export interface GitlabClientOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface RawIssue {
  iid: number;
  title: string;
  description?: string | null;
  state: "opened" | "closed";
  author: GitlabUser | null;
  labels?: ReadonlyArray<string>;
  milestone?: { title: string } | null;
  web_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
}

interface RawMergeRequest {
  iid: number;
  title: string;
  description?: string | null;
  state: "opened" | "closed" | "merged" | "locked";
  author: GitlabUser | null;
  labels?: ReadonlyArray<string>;
  milestone?: { title: string } | null;
  web_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  source_branch?: string;
  target_branch?: string;
}

interface RawNote {
  id: number;
  body: string;
  author: GitlabUser | null;
  created_at: string;
  updated_at: string;
  system?: boolean;
}

interface RawRelease {
  tag_name: string;
  name?: string | null;
  description?: string | null;
  author?: GitlabUser;
  released_at: string;
  _links?: { self?: string };
}

interface RawApprovals {
  approved_by?: ReadonlyArray<{ user?: { username?: string } | null } | null>;
}

export class GitlabClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: GitlabClientOptions = {}) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://gitlab.com";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "statewave-connectors-gitlab";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "gitlab",
      });
    }
  }

  private async request<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.token) headers["PRIVATE-TOKEN"] = this.token;

    const res = await this.fetchImpl(`${this.baseUrl}/api/v4${path}`, { headers });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError(`gitlab auth failed (${res.status})`, {
        code: res.status === 401 ? "auth_failed" : "permission_denied",
        connector: "gitlab",
        hint: "set GITLAB_TOKEN with the right scopes, or omit it for public-only reads",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError("gitlab resource not found", {
        code: "not_found",
        connector: "gitlab",
      });
    }
    if (res.status === 429 || res.headers.get("ratelimit-remaining") === "0") {
      throw new ConnectorError("gitlab rate limit exceeded", {
        code: "rate_limited",
        connector: "gitlab",
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`gitlab request failed: ${res.status}`, {
        code: "network",
        connector: "gitlab",
        retryable: res.status >= 500,
      });
    }
    return (await res.json()) as T;
  }

  private projectPrefix(repo: GitlabRepoRef): string {
    return `/projects/${encodeURIComponent(`${repo.owner}/${repo.name}`)}`;
  }

  async listIssues(
    repo: GitlabRepoRef,
    params: { since?: string; perPage?: number } = {},
  ): Promise<ReadonlyArray<GitlabIssue>> {
    const qs = new URLSearchParams();
    qs.set("scope", "all");
    qs.set("per_page", String(params.perPage ?? 100));
    if (params.since) qs.set("updated_after", params.since);
    const raw = await this.request<RawIssue[]>(
      `${this.projectPrefix(repo)}/issues?${qs.toString()}`,
    );
    return raw.map((it) => ({
      type: "issue",
      iid: it.iid,
      title: it.title,
      description: it.description ?? null,
      state: it.state,
      author: it.author,
      labels: it.labels ?? [],
      milestone: it.milestone ?? null,
      web_url: it.web_url,
      created_at: it.created_at,
      updated_at: it.updated_at,
      closed_at: it.closed_at ?? null,
    }));
  }

  async listMergeRequests(
    repo: GitlabRepoRef,
    params: { since?: string; perPage?: number } = {},
  ): Promise<ReadonlyArray<GitlabMergeRequest>> {
    const qs = new URLSearchParams();
    qs.set("scope", "all");
    qs.set("per_page", String(params.perPage ?? 100));
    if (params.since) qs.set("updated_after", params.since);
    const raw = await this.request<RawMergeRequest[]>(
      `${this.projectPrefix(repo)}/merge_requests?${qs.toString()}`,
    );
    return raw.map((it) => ({
      type: "merge_request",
      iid: it.iid,
      title: it.title,
      description: it.description ?? null,
      state: it.state,
      author: it.author,
      labels: it.labels ?? [],
      milestone: it.milestone ?? null,
      web_url: it.web_url,
      created_at: it.created_at,
      updated_at: it.updated_at,
      closed_at: it.closed_at ?? null,
      merged_at: it.merged_at ?? null,
      source_branch: it.source_branch,
      target_branch: it.target_branch,
    }));
  }

  async listNotes(
    repo: GitlabRepoRef,
    parent: { kind: "issue" | "merge_request"; iid: number; web_url: string },
    params: { perPage?: number } = {},
  ): Promise<ReadonlyArray<GitlabNote>> {
    const qs = new URLSearchParams();
    qs.set("per_page", String(params.perPage ?? 100));
    const endpoint = parent.kind === "issue" ? "issues" : "merge_requests";
    const raw = await this.request<RawNote[]>(
      `${this.projectPrefix(repo)}/${endpoint}/${parent.iid}/notes?${qs.toString()}`,
    );
    return raw
      .filter((n) => n.system !== true)
      .map((n) => ({
        type: "note",
        parent: parent.kind,
        parent_iid: parent.iid,
        parent_web_url: parent.web_url,
        id: n.id,
        body: n.body,
        author: n.author,
        created_at: n.created_at,
        updated_at: n.updated_at,
      }));
  }

  async listMergeRequestApprovals(
    repo: GitlabRepoRef,
    mr: { iid: number; web_url: string; updated_at: string },
  ): Promise<ReadonlyArray<GitlabApproval>> {
    const raw = await this.request<RawApprovals>(
      `${this.projectPrefix(repo)}/merge_requests/${mr.iid}/approvals`,
    );
    const approvedBy = raw.approved_by ?? [];
    const approvals: GitlabApproval[] = [];
    for (const entry of approvedBy) {
      const username = entry?.user?.username;
      if (!username) continue;
      approvals.push({
        type: "approval",
        mr_iid: mr.iid,
        mr_web_url: mr.web_url,
        approver: username,
        // The approvals endpoint carries no per-approval timestamp, so we fall
        // back to the MR's updated_at as the best available occurred_at.
        occurred_at: mr.updated_at,
      });
    }
    return approvals;
  }

  async listReleases(
    repo: GitlabRepoRef,
    params: { perPage?: number } = {},
  ): Promise<ReadonlyArray<GitlabRelease>> {
    const qs = new URLSearchParams();
    qs.set("per_page", String(params.perPage ?? 100));
    const raw = await this.request<RawRelease[]>(
      `${this.projectPrefix(repo)}/releases?${qs.toString()}`,
    );
    return raw.map((r) => ({
      type: "release",
      tag_name: r.tag_name,
      name: r.name ?? null,
      description: r.description ?? null,
      author: r.author,
      web_url: r._links?.self ?? "",
      released_at: r.released_at,
    }));
  }
}

export function parseRepoRef(spec: string): GitlabRepoRef {
  const parts = spec.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) {
    throw new ConnectorError(`invalid repo "${spec}", expected group/project (or group/sub/project)`, {
      code: "config_invalid",
      connector: "gitlab",
    });
  }
  const name = parts[parts.length - 1]!;
  const owner = parts.slice(0, -1).join("/");
  return { owner, name };
}
