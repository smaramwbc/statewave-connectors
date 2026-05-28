import { ConnectorError } from "@statewavedev/connectors-core";
import type {
  JiraAdfNode,
  JiraComment,
  JiraIssue,
  JiraSprint,
  JiraTransition,
  JiraUserRef,
} from "./types.js";

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
    /** Custom fields (e.g. the Sprint field) — keyed by `customfield_*`. */
    [field: string]: unknown;
  };
  /** Present when the issue was fetched with `expand=changelog`. */
  changelog?: RawChangelog;
}

export interface RawChangelogItem {
  field?: string;
  fromString?: string | null;
  toString?: string | null;
}

export interface RawChangelogHistory {
  id?: string;
  created?: string;
  author?: RawUser | null;
  items?: ReadonlyArray<RawChangelogItem>;
}

export interface RawChangelog {
  /** Search `expand=changelog` shape — full history. */
  histories?: ReadonlyArray<RawChangelogHistory>;
  /** Webhook shape — a single change's id + items (no `histories` wrapper). */
  id?: string;
  items?: ReadonlyArray<RawChangelogItem>;
}

interface RawSprint {
  id?: number;
  name?: string;
  state?: string;
  boardId?: number;
  originBoardId?: number;
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
    return (await this.searchIssuesDetailed(params)).issues;
  }

  /**
   * Like {@link searchIssues}, plus opt-in enrichment:
   *   - `expandChangelog` adds `expand=changelog` and extracts status
   *     transitions (`jira.issue.transition`).
   *   - `sprintField` names the Sprint custom field; when set it's requested
   *     and parsed into each issue's `sprints`.
   * No extra API calls beyond the same paged search — bounded, not a crawl.
   */
  async searchIssuesDetailed(params: {
    projects: ReadonlyArray<string>;
    since?: string;
    max: number;
    expandChangelog?: boolean;
    sprintField?: string;
  }): Promise<{ issues: JiraIssue[]; transitions: JiraTransition[] }> {
    const jql = this.buildJql(params.projects, params.since);
    const fields = params.sprintField
      ? `${ISSUE_FIELDS},${assertFieldId(params.sprintField)}`
      : ISSUE_FIELDS;

    const issues: JiraIssue[] = [];
    const transitions: JiraTransition[] = [];
    const pageSize = Math.min(50, Math.max(1, params.max));
    let startAt = 0;
    // Hard cap on pages so a misconfigured site can't loop forever.
    for (let page = 0; page < 200 && issues.length < params.max; page += 1) {
      const qs = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(pageSize),
        fields,
      });
      if (params.expandChangelog) qs.set("expand", "changelog");
      const body = await this.request<{
        total: number;
        issues?: ReadonlyArray<RawIssue>;
      }>(`/rest/api/3/search?${qs.toString()}`);
      const raws = body.issues ?? [];
      for (const raw of raws) {
        const issue = normalizeRawIssue(raw, this.baseUrl, params.sprintField);
        issues.push(issue);
        if (params.expandChangelog) {
          transitions.push(
            ...extractTransitions(raw.changelog, issue.key, issue.projectKey, this.baseUrl),
          );
        }
        if (issues.length >= params.max) break;
      }
      startAt += raws.length;
      if (raws.length === 0 || startAt >= body.total) break;
    }
    return { issues, transitions };
  }

  private buildJql(projectsRaw: ReadonlyArray<string>, since?: string): string {
    const projects = projectsRaw.map((p) => p.trim()).filter(Boolean);
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
    if (since) jql += ` AND updated >= "${toJqlTimestamp(since)}"`;
    return `${jql} ORDER BY updated DESC`;
  }

  async listComments(issueKey: string, projectKey: string): Promise<ReadonlyArray<JiraComment>> {
    const body = await this.request<{
      comments?: ReadonlyArray<RawComment>;
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`);
    const comments = body.comments ?? [];
    return comments.map((c) => normalizeRawComment(c, issueKey, projectKey, this.baseUrl));
  }

}

/** Validate a Jira field id (e.g. `customfield_10020`) before it goes in `fields`. */
function assertFieldId(field: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) {
    throw new ConnectorError(`invalid Jira field id "${field}"`, {
      code: "config_invalid",
      connector: "jira",
      hint: "the Sprint field id looks like customfield_10020",
    });
  }
  return field;
}

/**
 * Normalize a raw Jira issue (REST `fields` shape, also the shape Jira
 * webhook callbacks carry under `issue`) into the connector's {@link JiraIssue}.
 * ADF is flattened; user fields are reduced to displayName/accountId — never an
 * email. `baseUrl` is used to mint the `/browse/<KEY>` permalink.
 */
export function normalizeRawIssue(
  raw: RawIssue,
  baseUrl: string,
  sprintField?: string,
): JiraIssue {
  const f = raw.fields ?? {};
  const base = baseUrl.replace(/\/+$/, "");
  const sprints = sprintField ? parseSprints(f[sprintField]) : undefined;
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
    ...(sprints && sprints.length > 0 ? { sprints } : {}),
    url: `${base}/browse/${raw.key}`,
  };
}

/**
 * Parse the Jira Cloud Sprint custom field — an array of sprint objects
 * `{ id, name, state, boardId }`. Returns the kept fields, dropping anything
 * without a name. The legacy serialized-string sprint format is not parsed.
 */
export function parseSprints(value: unknown): JiraSprint[] {
  if (!Array.isArray(value)) return [];
  const out: JiraSprint[] = [];
  for (const s of value as ReadonlyArray<RawSprint>) {
    if (!s || typeof s !== "object" || typeof s.name !== "string") continue;
    out.push({
      id: typeof s.id === "number" ? s.id : undefined,
      name: s.name,
      state: typeof s.state === "string" ? s.state : undefined,
      boardId: typeof s.boardId === "number" ? s.boardId : s.originBoardId,
    });
  }
  return out;
}

/**
 * Extract status transitions from a raw changelog (both the search
 * `expand=changelog` `histories` shape and the webhook single-change shape).
 * Only status changes become transitions; histories are sorted by `created`
 * since Jira doesn't guarantee order.
 */
export function extractTransitions(
  changelog: RawChangelog | null | undefined,
  issueKey: string,
  projectKey: string,
  baseUrl: string,
  fallback?: { author?: string | null; occurredAt?: string },
): JiraTransition[] {
  if (!changelog) return [];
  const base = baseUrl.replace(/\/+$/, "");
  // Search `expand=changelog` carries each history's own author + created.
  // The webhook single-change shape carries neither (the actor + time live at
  // the payload top level), so a fallback supplies them.
  const histories: RawChangelogHistory[] = changelog.histories
    ? [...changelog.histories]
    : [{ id: changelog.id, items: changelog.items }];
  histories.sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));

  const out: JiraTransition[] = [];
  for (const h of histories) {
    const status = (h.items ?? []).find((i) => i.field === "status");
    if (!status || typeof status.toString !== "string") continue;
    out.push({
      type: "transition",
      issueKey,
      projectKey,
      changeId: h.id ?? `${issueKey}:${h.created ?? fallback?.occurredAt ?? ""}`,
      fromStatus: status.fromString ?? null,
      toStatus: status.toString,
      author: h.author ? userDisplay(h.author) : fallback?.author ?? null,
      occurredAt: h.created ?? fallback?.occurredAt ?? new Date().toISOString(),
      url: `${base}/browse/${issueKey}`,
    });
  }
  return out;
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
