import { ConnectorError } from "@statewavedev/connectors-core";
import type {
  GithubComment,
  GithubIssue,
  GithubPullRequest,
  GithubRelease,
  GithubRepoRef,
  GithubReview,
  GithubUser,
} from "./types.js";

export interface GithubClientOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface RawListItem {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  user: GithubUser | null;
  labels?: ReadonlyArray<{ name: string }>;
  milestone?: { title: string; number?: number } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
  merged_at?: string | null;
  base?: { ref: string };
  head?: { ref: string };
}

export class GithubClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: GithubClientOptions = {}) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "statewave-connectors-github";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "github",
      });
    }
  }

  private async request<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": this.userAgent,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError(`github auth failed (${res.status})`, {
        code: res.status === 401 ? "auth_failed" : "permission_denied",
        connector: "github",
        hint: "set GITHUB_TOKEN with the right scopes, or pass --no-auth for public-only reads",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError("github resource not found", {
        code: "not_found",
        connector: "github",
      });
    }
    if (res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0") {
      throw new ConnectorError("github rate limit exceeded", {
        code: "rate_limited",
        connector: "github",
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`github request failed: ${res.status}`, {
        code: "network",
        connector: "github",
        retryable: res.status >= 500,
      });
    }
    return (await res.json()) as T;
  }

  async listIssuesAndPrs(
    repo: GithubRepoRef,
    params: { since?: string; perPage?: number; state?: "open" | "closed" | "all" } = {},
  ): Promise<ReadonlyArray<GithubIssue | GithubPullRequest>> {
    const qs = new URLSearchParams();
    qs.set("state", params.state ?? "all");
    qs.set("per_page", String(params.perPage ?? 100));
    if (params.since) qs.set("since", params.since);
    const items = await this.request<RawListItem[]>(
      `/repos/${repo.owner}/${repo.name}/issues?${qs.toString()}`,
    );
    return items.map((it) => this.toIssueOrPr(it));
  }

  async listIssueComments(
    repo: GithubRepoRef,
    params: { since?: string; perPage?: number } = {},
  ): Promise<ReadonlyArray<GithubComment>> {
    const qs = new URLSearchParams();
    qs.set("per_page", String(params.perPage ?? 100));
    if (params.since) qs.set("since", params.since);
    const raw = await this.request<
      Array<{
        id: number;
        body: string;
        user: GithubUser | null;
        html_url: string;
        created_at: string;
        updated_at: string;
        issue_url: string;
      }>
    >(`/repos/${repo.owner}/${repo.name}/issues/comments?${qs.toString()}`);
    return raw.map((c) => ({
      type: "comment",
      // The /issues/comments endpoint returns both issue and PR-conversation
      // comments. GitHub doesn't distinguish them via issue_url (which always
      // points at /issues/N), but html_url for PR comments lives under /pull/.
      parent: c.html_url.includes("/pull/") ? "pull_request" : "issue",
      parent_number: parseTrailingNumber(c.issue_url),
      id: c.id,
      body: c.body,
      user: c.user,
      html_url: c.html_url,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
  }

  async listReleases(
    repo: GithubRepoRef,
    params: { perPage?: number } = {},
  ): Promise<ReadonlyArray<GithubRelease>> {
    const qs = new URLSearchParams();
    qs.set("per_page", String(params.perPage ?? 100));
    const raw = await this.request<
      Array<{
        id: number;
        tag_name: string;
        name?: string | null;
        body?: string | null;
        author: GithubUser | null;
        html_url: string;
        published_at: string | null;
        draft: boolean;
      }>
    >(`/repos/${repo.owner}/${repo.name}/releases?${qs.toString()}`);
    return raw
      .filter((r) => !r.draft && r.published_at)
      .map((r) => ({
        type: "release",
        id: r.id,
        tag_name: r.tag_name,
        name: r.name,
        body: r.body,
        author: r.author,
        html_url: r.html_url,
        published_at: r.published_at!,
      }));
  }

  async listPrReviews(
    repo: GithubRepoRef,
    prNumber: number,
  ): Promise<ReadonlyArray<GithubReview>> {
    const raw = await this.request<
      Array<{
        id: number;
        user: GithubUser | null;
        state: string;
        body?: string | null;
        html_url: string;
        submitted_at: string | null;
      }>
    >(`/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews`);
    return raw
      .filter((r) => r.submitted_at)
      .map((r) => ({
        type: "review",
        pr_number: prNumber,
        id: r.id,
        user: r.user,
        state: r.state as GithubReview["state"],
        body: r.body,
        html_url: r.html_url,
        submitted_at: r.submitted_at!,
      }));
  }

  private toIssueOrPr(it: RawListItem): GithubIssue | GithubPullRequest {
    const labels = (it.labels ?? []).map((l) => ({ name: l.name }));
    if (it.pull_request) {
      const pr: GithubPullRequest = {
        type: "pull_request",
        number: it.number,
        title: it.title,
        body: it.body ?? null,
        state: it.state,
        merged: !!it.merged_at,
        user: it.user,
        labels,
        milestone: it.milestone ?? null,
        html_url: it.html_url,
        created_at: it.created_at,
        updated_at: it.updated_at,
        closed_at: it.closed_at ?? null,
        merged_at: it.merged_at ?? null,
        base: it.base,
        head: it.head,
      };
      return pr;
    }
    const issue: GithubIssue = {
      type: "issue",
      number: it.number,
      title: it.title,
      body: it.body ?? null,
      state: it.state,
      user: it.user,
      labels,
      milestone: it.milestone ?? null,
      html_url: it.html_url,
      created_at: it.created_at,
      updated_at: it.updated_at,
      closed_at: it.closed_at ?? null,
    };
    return issue;
  }
}

function parseTrailingNumber(url: string): number {
  const m = url.match(/\/(\d+)(?:[/?]|$)/);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}

export function parseRepoRef(spec: string): GithubRepoRef {
  const parts = spec.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ConnectorError(`invalid repo "${spec}", expected owner/name`, {
      code: "config_invalid",
      connector: "github",
    });
  }
  return { owner: parts[0], name: parts[1] };
}
