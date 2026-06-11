import { ConnectorError } from "@statewavedev/connectors-core";
import type {
  JiraAdfNode,
  JiraComment,
  JiraIssue,
  JiraSprint,
  JiraTransition,
  JiraUserRef,
} from "./types.js";

/** Which Jira flavour to talk to — they differ in REST path, auth, and bodies. */
export type JiraDeployment = "cloud" | "server";

export interface JiraClientOptions {
  /** Jira site base URL — `https://myorg.atlassian.net` (cloud) or your on-prem host (server/DC). */
  baseUrl: string;
  /**
   * Deployment flavour. `cloud` (default) → REST v3, Basic email:token auth,
   * ADF bodies. `server` (Jira Server / Data Center) → REST v2, Bearer PAT (or
   * Basic username:password) auth, plain-text bodies.
   */
  deployment?: JiraDeployment;
  /** Cloud: Atlassian account email (Basic username). Server: Basic username (with `apiToken` as the password). */
  email?: string;
  /** Cloud: API token. Server (Basic): the password. (https://id.atlassian.com/manage-profile/security/api-tokens) */
  apiToken?: string;
  /** Server / Data Center personal access token — sent as `Authorization: Bearer <PAT>`. */
  personalAccessToken?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const ISSUE_FIELDS_LIST = [
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
];
// Server/DC GET search takes a comma-joined `fields` query param; Cloud's
// POST /search/jql takes a `fields` array — keep both shapes from one source.
const ISSUE_FIELDS = ISSUE_FIELDS_LIST.join(",");

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]+$/;

export interface RawUser {
  accountId?: string;
  displayName?: string;
  /** Server / Data Center username (login). Cloud doesn't expose this. */
  name?: string;
}

export interface RawIssue {
  key: string;
  fields: {
    summary?: string | null;
    /** ADF object (Cloud v3) or plain-text/wiki string (Server/DC v2). */
    description?: JiraAdfNode | string | null;
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
  /** ADF object (Cloud v3) or plain-text/wiki string (Server/DC v2). */
  body?: JiraAdfNode | string | null;
  created?: string | null;
  updated?: string | null;
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly apiBase: string;
  private readonly deployment: JiraDeployment;

  constructor(options: JiraClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "statewave-connectors-jira";
    const deployment: JiraDeployment = options.deployment ?? "cloud";
    this.deployment = deployment;
    // Cloud has REST v3 (ADF); Server / Data Center only has v2 (plain text).
    this.apiBase = deployment === "server" ? "/rest/api/2" : "/rest/api/3";
    if (!this.baseUrl || !/^https?:\/\//.test(this.baseUrl)) {
      throw new ConnectorError(`invalid Jira base URL "${options.baseUrl}"`, {
        code: "config_invalid",
        connector: "jira",
        hint: "expected something like https://myorg.atlassian.net (cloud) or your on-prem host",
      });
    }
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "jira",
      });
    }
    this.authHeader = resolveAuthHeader(deployment, options);
  }

  private async request<T>(
    path: string,
    init?: { method?: string; body?: string },
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": this.userAgent,
        Authorization: this.authHeader,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body,
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
    const sprintFieldId = params.sprintField ? assertFieldId(params.sprintField) : undefined;

    const issues: JiraIssue[] = [];
    const transitions: JiraTransition[] = [];
    const pageSize = Math.min(50, Math.max(1, params.max));

    // Per-page processing shared by both deployment paths. Returns once the
    // caller's `max` is reached so neither loop over-fetches.
    const ingest = (raws: ReadonlyArray<RawIssue>): void => {
      for (const raw of raws) {
        const issue = normalizeRawIssue(raw, this.baseUrl, params.sprintField);
        issues.push(issue);
        if (params.expandChangelog) {
          transitions.push(
            ...extractTransitions(raw.changelog, issue.key, issue.projectKey, this.baseUrl),
          );
        }
        if (issues.length >= params.max) return;
      }
    };

    if (this.deployment === "server") {
      // Server / Data Center still serves the classic GET /rest/api/2/search
      // with startAt pagination and a `total` count.
      const fields = sprintFieldId ? `${ISSUE_FIELDS},${sprintFieldId}` : ISSUE_FIELDS;
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
        }>(`${this.apiBase}/search?${qs.toString()}`);
        const raws = body.issues ?? [];
        ingest(raws);
        startAt += raws.length;
        if (raws.length === 0 || startAt >= body.total) break;
      }
      return { issues, transitions };
    }

    // Jira Cloud removed GET /rest/api/{2,3}/search (HTTP 410, CHANGE-2046).
    // The replacement is POST /rest/api/3/search/jql: `fields`/`expand` are
    // arrays, there is no `total`, and the next page is requested by echoing
    // back `nextPageToken`. `isLast` is unreliable in the field, so we stop
    // when the token is absent (or a page is empty), with the same hard page
    // cap as a backstop against an endlessly-chaining token.
    const fields = sprintFieldId ? [...ISSUE_FIELDS_LIST, sprintFieldId] : ISSUE_FIELDS_LIST;
    let nextPageToken: string | undefined;
    for (let page = 0; page < 200 && issues.length < params.max; page += 1) {
      const reqBody: Record<string, unknown> = { jql, maxResults: pageSize, fields };
      if (params.expandChangelog) reqBody.expand = ["changelog"];
      if (nextPageToken) reqBody.nextPageToken = nextPageToken;
      const body = await this.request<{
        issues?: ReadonlyArray<RawIssue>;
        nextPageToken?: string;
        isLast?: boolean;
      }>(`${this.apiBase}/search/jql`, {
        method: "POST",
        body: JSON.stringify(reqBody),
      });
      const raws = body.issues ?? [];
      ingest(raws);
      if (raws.length === 0 || body.isLast || !body.nextPageToken) break;
      nextPageToken = body.nextPageToken;
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
    }>(`${this.apiBase}/issue/${encodeURIComponent(issueKey)}/comment`);
    const comments = body.comments ?? [];
    return comments.map((c) => normalizeRawComment(c, issueKey, projectKey, this.baseUrl));
  }

}

/**
 * Resolve the `Authorization` header for the deployment:
 *   - cloud  → Basic base64(email:apiToken)
 *   - server → Bearer <PAT>, or Basic base64(username:password) as a fallback
 */
function resolveAuthHeader(deployment: JiraDeployment, options: JiraClientOptions): string {
  if (deployment === "server") {
    if (options.personalAccessToken) return `Bearer ${options.personalAccessToken}`;
    if (options.email && options.apiToken) {
      return `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`;
    }
    throw new ConnectorError(
      "Jira Server/Data Center auth is required — provide a personal access token (Bearer) or username + password (Basic)",
      {
        code: "auth_missing",
        connector: "jira",
        hint: "set JIRA_PAT for a personal access token, or JIRA_EMAIL + JIRA_API_TOKEN for username:password basic auth",
      },
    );
  }
  if (!options.email || !options.apiToken) {
    throw new ConnectorError("Jira Cloud email + API token are required", {
      code: "auth_missing",
      connector: "jira",
      hint: "set JIRA_EMAIL + JIRA_API_TOKEN, or use --deployment server with a PAT",
    });
  }
  return `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`;
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
    description: flattenBody(f.description),
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
    body: flattenBody(c.body),
    created: c.created ?? new Date().toISOString(),
    updated: c.updated ?? c.created ?? new Date().toISOString(),
    url: `${base}/browse/${issueKey}?focusedCommentId=${c.id}`,
  };
}

/**
 * displayName ?? name (server username) ?? accountId ?? null — deliberately
 * never the email address.
 */
export function userDisplay(user: JiraUserRef | null | undefined): string | null {
  if (!user) return null;
  return user.displayName ?? user.name ?? user.accountId ?? null;
}

/**
 * Normalize a rich-text body to plain text across deployments. Jira Cloud (v3)
 * returns an ADF document object; Jira Server / Data Center (v2) returns a plain
 * string (wiki markup). Strings pass through trimmed; ADF objects are flattened.
 */
export function flattenBody(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return flattenAdf(value as JiraAdfNode);
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
