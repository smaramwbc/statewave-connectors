import { ConnectorError } from "@statewavedev/connectors-core";
import type {
  BitbucketComment,
  BitbucketIssue,
  BitbucketPullRequest,
  BitbucketRepoRef,
  BitbucketUser,
} from "./types.js";

export interface BitbucketClientOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

/** Hard cap on pages followed via `next` to avoid runaway pagination. */
const MAX_PAGES = 200;

interface BitbucketPage<T> {
  values?: ReadonlyArray<T>;
  next?: string;
}

interface RawPr {
  id: number;
  title: string;
  description?: string | null;
  state: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED" | string;
  author?: BitbucketUser | null;
  created_on: string;
  updated_on: string;
  links?: { html?: { href?: string } };
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
}

interface RawIssue {
  id: number;
  title: string;
  content?: { raw?: string | null } | null;
  state:
    | "new"
    | "open"
    | "resolved"
    | "closed"
    | "on hold"
    | "invalid"
    | "duplicate"
    | "wontfix"
    | string;
  reporter?: BitbucketUser | null;
  created_on: string;
  updated_on: string;
  links?: { html?: { href?: string } };
}

interface RawComment {
  id: number;
  content?: { raw?: string | null } | null;
  user?: BitbucketUser | null;
  created_on: string;
  updated_on: string;
  links?: { html?: { href?: string } };
  deleted?: boolean;
}

const CLOSED_ISSUE_STATES = new Set(["resolved", "closed", "invalid", "duplicate", "wontfix"]);

export class BitbucketClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: BitbucketClientOptions = {}) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://api.bitbucket.org/2.0";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "statewave-connectors-bitbucket";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "bitbucket",
      });
    }
  }

  /**
   * Accepts either a path (prefixed with baseUrl) or an absolute URL such as a
   * `next` page link returned by the API (used verbatim).
   */
  private async request<T>(pathOrUrl: string): Promise<T> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const res = await this.fetchImpl(url, { headers });
    if (res.status === 401) {
      throw new ConnectorError("bitbucket auth failed (401)", {
        code: "auth_failed",
        connector: "bitbucket",
        hint: "set BITBUCKET_TOKEN (an access token / OAuth token), or omit auth for public-only reads",
      });
    }
    if (res.status === 403) {
      throw new ConnectorError("bitbucket permission denied (403)", {
        code: "permission_denied",
        connector: "bitbucket",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError("bitbucket resource not found", {
        code: "not_found",
        connector: "bitbucket",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError("bitbucket rate limit exceeded", {
        code: "rate_limited",
        connector: "bitbucket",
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`bitbucket request failed: ${res.status}`, {
        code: "network",
        connector: "bitbucket",
        retryable: res.status >= 500,
      });
    }
    return (await res.json()) as T;
  }

  /**
   * Follows `next` page links until exhausted, `maxItems` reached, or the hard
   * page cap is hit. Returns the flattened `values[]` across pages.
   */
  private async paginate<T>(firstPath: string, maxItems?: number): Promise<ReadonlyArray<T>> {
    const out: T[] = [];
    let nextUrl: string | undefined = firstPath;
    let pages = 0;
    while (nextUrl && pages < MAX_PAGES) {
      const page: BitbucketPage<T> = await this.request<BitbucketPage<T>>(nextUrl);
      for (const v of page.values ?? []) {
        out.push(v);
        if (maxItems !== undefined && out.length >= maxItems) return out;
      }
      nextUrl = page.next;
      pages += 1;
    }
    return out;
  }

  async listPullRequests(
    repo: BitbucketRepoRef,
    params: { since?: string; pageLen?: number; maxItems?: number } = {},
  ): Promise<ReadonlyArray<BitbucketPullRequest>> {
    const qs = new URLSearchParams();
    for (const state of ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]) qs.append("state", state);
    qs.set("pagelen", String(params.pageLen ?? 50));
    if (params.since) qs.set("q", `updated_on > "${params.since}"`);
    const raw = await this.paginate<RawPr>(
      `/repositories/${repo.owner}/${repo.name}/pullrequests?${qs.toString()}`,
      params.maxItems,
    );
    return raw.map((pr) => this.toPr(pr));
  }

  async listIssues(
    repo: BitbucketRepoRef,
    params: { since?: string; pageLen?: number; maxItems?: number } = {},
  ): Promise<ReadonlyArray<BitbucketIssue>> {
    const qs = new URLSearchParams();
    qs.set("pagelen", String(params.pageLen ?? 50));
    if (params.since) qs.set("q", `updated_on > "${params.since}"`);
    try {
      const raw = await this.paginate<RawIssue>(
        `/repositories/${repo.owner}/${repo.name}/issues?${qs.toString()}`,
        params.maxItems,
      );
      return raw.map((it) => this.toIssue(it));
    } catch (err) {
      // The issue tracker is an optional, per-repo feature. When disabled the
      // API returns 404 — skip issues gracefully rather than failing the sync.
      if (err instanceof ConnectorError && err.code === "not_found") return [];
      throw err;
    }
  }

  async listPrComments(
    repo: BitbucketRepoRef,
    prId: number,
    params: { since?: string; pageLen?: number; maxItems?: number } = {},
  ): Promise<ReadonlyArray<BitbucketComment>> {
    const qs = new URLSearchParams();
    qs.set("pagelen", String(params.pageLen ?? 50));
    if (params.since) qs.set("q", `updated_on > "${params.since}"`);
    const raw = await this.paginate<RawComment>(
      `/repositories/${repo.owner}/${repo.name}/pullrequests/${prId}/comments?${qs.toString()}`,
      params.maxItems,
    );
    const out: BitbucketComment[] = [];
    for (const c of raw) {
      // Skip deleted comments and inline/system comments that carry no raw body.
      if (c.deleted) continue;
      const body = c.content?.raw;
      if (!body) continue;
      out.push({
        type: "comment",
        parent: "pull_request",
        parent_id: prId,
        id: c.id,
        body,
        user: c.user ?? null,
        html_url: c.links?.html?.href ?? "",
        created_at: c.created_on,
        updated_at: c.updated_on,
      });
    }
    return out;
  }

  async listIssueComments(
    repo: BitbucketRepoRef,
    issueId: number,
    params: { since?: string; pageLen?: number; maxItems?: number } = {},
  ): Promise<ReadonlyArray<BitbucketComment>> {
    const qs = new URLSearchParams();
    qs.set("pagelen", String(params.pageLen ?? 50));
    if (params.since) qs.set("q", `updated_on > "${params.since}"`);
    try {
      const raw = await this.paginate<RawComment>(
        `/repositories/${repo.owner}/${repo.name}/issues/${issueId}/comments?${qs.toString()}`,
        params.maxItems,
      );
      const out: BitbucketComment[] = [];
      for (const c of raw) {
        // Skip deleted comments and system comments that carry no raw body.
        if (c.deleted) continue;
        const body = c.content?.raw;
        if (!body) continue;
        out.push({
          type: "comment",
          parent: "issue",
          parent_id: issueId,
          id: c.id,
          body,
          user: c.user ?? null,
          html_url: c.links?.html?.href ?? "",
          created_at: c.created_on,
          updated_at: c.updated_on,
        });
      }
      return out;
    } catch (err) {
      // The issue tracker is an optional, per-repo feature. When disabled (or a
      // specific issue is gone) the API returns 404 — skip gracefully rather
      // than failing the sync, mirroring listIssues.
      if (err instanceof ConnectorError && err.code === "not_found") return [];
      throw err;
    }
  }

  private toPr(pr: RawPr): BitbucketPullRequest {
    const merged = pr.state === "MERGED";
    const declined = pr.state === "DECLINED" || pr.state === "SUPERSEDED";
    return {
      type: "pull_request",
      id: pr.id,
      title: pr.title,
      body: pr.description ?? null,
      state: merged || declined ? "closed" : "open",
      merged,
      declined,
      user: pr.author ?? null,
      html_url: pr.links?.html?.href ?? "",
      created_at: pr.created_on,
      updated_at: pr.updated_on,
      source_branch: pr.source?.branch?.name,
      destination_branch: pr.destination?.branch?.name,
    };
  }

  private toIssue(it: RawIssue): BitbucketIssue {
    const closed = CLOSED_ISSUE_STATES.has(it.state);
    return {
      type: "issue",
      id: it.id,
      title: it.title,
      body: it.content?.raw ?? null,
      state: closed ? "closed" : "open",
      user: it.reporter ?? null,
      html_url: it.links?.html?.href ?? "",
      created_at: it.created_on,
      updated_at: it.updated_on,
    };
  }
}

export function parseRepoRef(spec: string): BitbucketRepoRef {
  const parts = spec.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ConnectorError(`invalid repo "${spec}", expected workspace/repo`, {
      code: "config_invalid",
      connector: "bitbucket",
    });
  }
  return { owner: parts[0], name: parts[1] };
}
