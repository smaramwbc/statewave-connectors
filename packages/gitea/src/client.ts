import { ConnectorError } from "@statewavedev/connectors-core";
import type {
  GiteaComment,
  GiteaIssue,
  GiteaPullRequest,
  GiteaRelease,
  GiteaRepoRef,
  GiteaReview,
  GiteaUser,
} from "./types.js";

export interface GiteaClientOptions {
  token?: string;
  /** Self-hosted Gitea / Forgejo base URL, e.g. https://gitea.example.com. Required. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

// Hard cap on pages to walk for any paginated endpoint, so a misbehaving
// instance can't loop forever. Page size is 50 → 100 pages == 5,000 items.
const MAX_PAGES = 100;

interface RawIssueOrPr {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  user: GiteaUser | null;
  labels?: ReadonlyArray<{ name: string }>;
  milestone?: { title: string; id?: number } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged?: boolean;
  merged_at?: string | null;
  base?: { ref: string };
  head?: { ref: string };
}

export class GiteaClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: GiteaClientOptions) {
    if (!options.baseUrl) {
      throw new ConnectorError("gitea baseUrl is required (e.g. https://gitea.example.com)", {
        code: "config_invalid",
        connector: "gitea",
        hint: "pass --host https://gitea.example.com or set GITEA_URL",
      });
    }
    this.token = options.token;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "statewave-connectors-gitea";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "gitea",
      });
    }
  }

  private async request<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.token) headers.Authorization = `token ${this.token}`;

    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, { headers });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError(`gitea auth failed (${res.status})`, {
        code: res.status === 401 ? "auth_failed" : "permission_denied",
        connector: "gitea",
        hint: "set GITEA_TOKEN with the right scopes, or omit it for public-only reads",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError("gitea resource not found", {
        code: "not_found",
        connector: "gitea",
      });
    }
    if (res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0") {
      throw new ConnectorError("gitea rate limit exceeded", {
        code: "rate_limited",
        connector: "gitea",
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`gitea request failed: ${res.status}`, {
        code: "network",
        connector: "gitea",
        retryable: res.status >= 500,
      });
    }
    return (await res.json()) as T;
  }

  async listIssues(
    repo: GiteaRepoRef,
    params: { perPage?: number } = {},
  ): Promise<ReadonlyArray<GiteaIssue>> {
    const limit = params.perPage ?? 50;
    const out: GiteaIssue[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const qs = new URLSearchParams();
      qs.set("type", "issues");
      qs.set("state", "all");
      qs.set("limit", String(limit));
      qs.set("page", String(page));
      const items = await this.request<RawIssueOrPr[]>(
        `/repos/${repo.owner}/${repo.name}/issues?${qs.toString()}`,
      );
      for (const it of items) out.push(this.toIssue(it));
      if (items.length < limit) break;
    }
    return out;
  }

  async listPulls(
    repo: GiteaRepoRef,
    params: { perPage?: number } = {},
  ): Promise<ReadonlyArray<GiteaPullRequest>> {
    const limit = params.perPage ?? 50;
    const out: GiteaPullRequest[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const qs = new URLSearchParams();
      qs.set("state", "all");
      qs.set("limit", String(limit));
      qs.set("page", String(page));
      const items = await this.request<RawIssueOrPr[]>(
        `/repos/${repo.owner}/${repo.name}/pulls?${qs.toString()}`,
      );
      for (const it of items) out.push(this.toPullRequest(it));
      if (items.length < limit) break;
    }
    return out;
  }

  async listIssueComments(
    repo: GiteaRepoRef,
    params: { since?: string; perPage?: number } = {},
  ): Promise<ReadonlyArray<GiteaComment>> {
    const limit = params.perPage ?? 50;
    const out: GiteaComment[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      qs.set("page", String(page));
      if (params.since) qs.set("since", params.since);
      const raw = await this.request<
        Array<{
          id: number;
          body: string;
          user: GiteaUser | null;
          html_url: string;
          created_at: string;
          updated_at: string;
          issue_url: string;
        }>
      >(`/repos/${repo.owner}/${repo.name}/issues/comments?${qs.toString()}`);
      for (const c of raw) {
        out.push({
          type: "comment",
          // The /issues/comments endpoint returns both issue and PR-conversation
          // comments. Gitea, like GitHub, exposes PR comments under a /pulls/ (or
          // /pull/) html_url, while issue_url always points at the parent number.
          parent: c.html_url.includes("/pulls/") || c.html_url.includes("/pull/") ? "pull_request" : "issue",
          parent_number: parseTrailingNumber(c.issue_url),
          id: c.id,
          body: c.body,
          user: c.user,
          html_url: c.html_url,
          created_at: c.created_at,
          updated_at: c.updated_at,
        });
      }
      if (raw.length < limit) break;
    }
    return out;
  }

  async listReleases(
    repo: GiteaRepoRef,
    params: { perPage?: number } = {},
  ): Promise<ReadonlyArray<GiteaRelease>> {
    const limit = params.perPage ?? 50;
    const out: GiteaRelease[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      qs.set("page", String(page));
      const raw = await this.request<
        Array<{
          id: number;
          tag_name: string;
          name?: string | null;
          body?: string | null;
          author: GiteaUser | null;
          html_url: string;
          published_at: string | null;
          draft: boolean;
        }>
      >(`/repos/${repo.owner}/${repo.name}/releases?${qs.toString()}`);
      for (const r of raw) {
        if (r.draft || !r.published_at) continue;
        out.push({
          type: "release",
          id: r.id,
          tag_name: r.tag_name,
          name: r.name,
          body: r.body,
          author: r.author,
          html_url: r.html_url,
          published_at: r.published_at,
        });
      }
      if (raw.length < limit) break;
    }
    return out;
  }

  async listPrReviews(
    repo: GiteaRepoRef,
    prNumber: number,
  ): Promise<ReadonlyArray<GiteaReview>> {
    const raw = await this.request<
      Array<{
        id: number;
        user: GiteaUser | null;
        state: string;
        body?: string | null;
        html_url: string;
        submitted_at: string | null;
      }>
    >(`/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews`);
    return raw
      .filter((r) => r.submitted_at && r.state !== "PENDING")
      .map((r) => ({
        type: "review",
        pr_number: prNumber,
        id: r.id,
        user: r.user,
        state: r.state as GiteaReview["state"],
        body: r.body,
        html_url: r.html_url,
        submitted_at: r.submitted_at!,
      }));
  }

  private toIssue(it: RawIssueOrPr): GiteaIssue {
    return {
      type: "issue",
      number: it.number,
      title: it.title,
      body: it.body ?? null,
      state: it.state,
      user: it.user,
      labels: (it.labels ?? []).map((l) => ({ name: l.name })),
      milestone: it.milestone ?? null,
      html_url: it.html_url,
      created_at: it.created_at,
      updated_at: it.updated_at,
      closed_at: it.closed_at ?? null,
    };
  }

  private toPullRequest(it: RawIssueOrPr): GiteaPullRequest {
    return {
      type: "pull_request",
      number: it.number,
      title: it.title,
      body: it.body ?? null,
      state: it.state,
      merged: it.merged ?? !!it.merged_at,
      user: it.user,
      labels: (it.labels ?? []).map((l) => ({ name: l.name })),
      milestone: it.milestone ?? null,
      html_url: it.html_url,
      created_at: it.created_at,
      updated_at: it.updated_at,
      closed_at: it.closed_at ?? null,
      merged_at: it.merged_at ?? null,
      base: it.base,
      head: it.head,
    };
  }
}

function parseTrailingNumber(url: string): number {
  const m = url.match(/\/(\d+)(?:[/?]|$)/);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}

export function parseRepoRef(spec: string): GiteaRepoRef {
  const parts = spec.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ConnectorError(`invalid repo "${spec}", expected owner/name`, {
      code: "config_invalid",
      connector: "gitea",
    });
  }
  return { owner: parts[0], name: parts[1] };
}
