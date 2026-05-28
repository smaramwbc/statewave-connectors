import { ConnectorError } from "@statewavedev/connectors-core";
import type { JiraAdfNode, JiraComment, JiraIssue, JiraUserRef } from "./types.js";

export interface JiraClientOptions {
  /** Jira Cloud site base URL, e.g. https://myorg.atlassian.net */
  baseUrl: string;
  /** Atlassian account email (the basic-auth username). */
  email: string;
  /** Atlassian API token (https://id.atlassian.com/manage-profile/security/api-tokens). */
  apiToken: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const ISSUE_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "labels",
  "assignee",
  "reporter",
  "created",
  "updated",
  "resolutiondate",
  "project",
  "description",
].join(",");

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]+$/;

export interface RawUser {
  accountId?: string;
  displayName?: string;
}

export interface RawIssue {
  key: string;
  fields: {
    summary?: string | null;
    description?: JiraAdfNode | null;
    status?: { name?: string; statusCategory?: { key?: string } } | null;
    issuetype?: { name?: string } | null;
    priority?: { name?: string } | null;
    labels?: ReadonlyArray<string> | null;
    assignee?: RawUser | null;
    reporter?: RawUser | null;
    project?: { key?: string } | null;
    created?: string | null;
    updated?: string | null;
    resolutiondate?: string | null;
  };
}

export interface RawComment {
  id: string;
  author?: RawUser | null;
  body?: JiraAdfNode | null;
  created?: string | null;
  updated?: string | null;
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: JiraClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "statewave-connectors-jira";
    if (!this.baseUrl || !/^https?:\/\//.test(this.baseUrl)) {
      throw new ConnectorError(`invalid Jira base URL "${options.baseUrl}"`, {
        code: "config_invalid",
        connector: "jira",
        hint: "expected something like https://myorg.atlassian.net",
      });
    }
    if (!options.email || !options.apiToken) {
      throw new ConnectorError("Jira email + API token are required", {
        code: "auth_missing",
        connector: "jira",
      });
    }
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "jira",
      });
    }
    const basic = Buffer.from(`${options.email}:${options.apiToken}`).toString("base64");
    this.authHeader = `Basic ${basic}`;
  }

  private async request<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": this.userAgent,
        Authorization: this.authHeader,
      },
    });
    if (res.status === 401) {
      throw new ConnectorError("jira auth failed (401)", {
        code: "auth_failed",
        connector: "jira",
        hint: "check JIRA_EMAIL + JIRA_API_TOKEN; the token must belong to that account",
      });
    }
    if (res.status === 403) {
      throw new ConnectorError("jira permission denied (403)", {
        code: "permission_denied",
        connector: "jira",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError("jira resource not found (404)", {
        code: "not_found",
        connector: "jira",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError("jira rate limit exceeded (429)", {
        code: "rate_limited",
        connector: "jira",
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`jira request failed: ${res.status}`, {
        code: "network",
        connector: "jira",
        retryable: res.status >= 500,
      });
    }
    return (await res.json()) as T;
  }

  /**
   * Pull issues for the allowlisted projects, newest-activity first, up to
   * `max`. Project keys are validated to keep them out of JQL injection range.
   */
  async searchIssues(params: {
    projects: ReadonlyArray<string>;
    since?: string;
    max: number;
  }): Promise<ReadonlyArray<JiraIssue>> {
    const projects = params.projects.map((p) => p.trim()).filter(Boolean);
    if (projects.length === 0) {
      throw new ConnectorError("at least one Jira project key is required", {
        code: "config_invalid",
        connector: "jira",
        hint: "pass --projects ENG,PLATFORM — ingesting an entire site by default would be surprising",
      });
    }
    for (const p of projects) {
      if (!PROJECT_KEY.test(p)) {
        throw new ConnectorError(`invalid Jira project key "${p}"`, {
          code: "config_invalid",
          connector: "jira",
          hint: "project keys are letters/digits/underscores, e.g. ENG, PLAT2",
        });
      }
    }

    let jql = `project in (${projects.join(",")})`;
    if (params.since) {
      jql += ` AND updated >= "${toJqlTimestamp(params.since)}"`;
    }
    jql += " ORDER BY updated DESC";

    const pageSize = Math.min(50, Math.max(1, params.max));
    const collected: JiraIssue[] = [];
    let startAt = 0;
    // Hard cap on pages so a misconfigured site can't loop forever.
    for (let page = 0; page < 200 && collected.length < params.max; page += 1) {
      const qs = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(pageSize),
        fields: ISSUE_FIELDS,
      });
      const body = await this.request<{
        startAt: number;
        maxResults: number;
        total: number;
        issues?: ReadonlyArray<RawIssue>;
      }>(`/rest/api/3/search?${qs.toString()}`);
      const issues = body.issues ?? [];
      for (const raw of issues) {
        collected.push(this.toIssue(raw));
        if (collected.length >= params.max) break;
      }
      startAt += issues.length;
      if (issues.length === 0 || startAt >= body.total) break;
    }
    return collected;
  }

  async listComments(issueKey: string, projectKey: string): Promise<ReadonlyArray<JiraComment>> {
    const body = await this.request<{
      comments?: ReadonlyArray<RawComment>;
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`);
    const comments = body.comments ?? [];
    return comments.map((c) => normalizeRawComment(c, issueKey, projectKey, this.baseUrl));
  }

  private toIssue(raw: RawIssue): JiraIssue {
    return normalizeRawIssue(raw, this.baseUrl);
  }
}

/**
 * Normalize a raw Jira issue (REST `fields` shape, also the shape Jira
 * webhook callbacks carry under `issue`) into the connector's {@link JiraIssue}.
 * ADF is flattened; user fields are reduced to displayName/accountId — never an
 * email. `baseUrl` is used to mint the `/browse/<KEY>` permalink.
 */
export function normalizeRawIssue(raw: RawIssue, baseUrl: string): JiraIssue {
  const f = raw.fields ?? {};
  const base = baseUrl.replace(/\/+$/, "");
  return {
    type: "issue",
    key: raw.key,
    projectKey: f.project?.key ?? raw.key.split("-")[0] ?? "UNKNOWN",
    summary: f.summary ?? "",
    description: flattenAdf(f.description),
    statusName: f.status?.name ?? "Unknown",
    statusCategory: f.status?.statusCategory?.key ?? "indeterminate",
    issueType: f.issuetype?.name ?? undefined,
    priority: f.priority?.name ?? undefined,
    labels: f.labels ?? [],
    assignee: userDisplay(f.assignee),
    reporter: userDisplay(f.reporter),
    created: f.created ?? new Date().toISOString(),
    updated: f.updated ?? f.created ?? new Date().toISOString(),
    resolutionDate: f.resolutiondate ?? null,
    url: `${base}/browse/${raw.key}`,
  };
}

/** Normalize a raw Jira comment (REST + webhook `comment` shape) → {@link JiraComment}. */
export function normalizeRawComment(
  c: RawComment,
  issueKey: string,
  projectKey: string,
  baseUrl: string,
): JiraComment {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    type: "comment",
    id: c.id,
    issueKey,
    projectKey,
    author: userDisplay(c.author),
    body: flattenAdf(c.body),
    created: c.created ?? new Date().toISOString(),
    updated: c.updated ?? c.created ?? new Date().toISOString(),
    url: `${base}/browse/${issueKey}?focusedCommentId=${c.id}`,
  };
}

/** displayName ?? accountId ?? null — deliberately never the email address. */
export function userDisplay(user: JiraUserRef | null | undefined): string | null {
  if (!user) return null;
  return user.displayName ?? user.accountId ?? null;
}

/**
 * Flatten an Atlassian Document Format node to plain text. Concatenates `text`
 * leaves and breaks block-level nodes onto their own lines. Deterministic and
 * dependency-free so it is unit-testable.
 */
export function flattenAdf(node: JiraAdfNode | null | undefined): string {
  if (!node) return "";
  const out: string[] = [];
  walkAdf(node, out);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

const ADF_BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "codeBlock",
  "rule",
]);

function walkAdf(node: JiraAdfNode, out: string[]): void {
  if (typeof node.text === "string") out.push(node.text);
  if (node.type === "hardBreak") out.push("\n");
  if (node.content) {
    for (const child of node.content) walkAdf(child, out);
  }
  if (node.type && ADF_BLOCKS.has(node.type)) out.push("\n");
}

function toJqlTimestamp(iso: string): string {
  // Jira JQL accepts "yyyy/MM/dd HH:mm". Convert from an ISO date defensively.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
