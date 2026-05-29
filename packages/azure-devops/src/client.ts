import { ConnectorError } from "@statewavedev/connectors-core";
import type {
  AzureComment,
  AzurePullRequest,
  AzureRepoRef,
  AzureReview,
  AzureWorkItem,
} from "./types.js";

export interface AzureClientOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const API_VERSION = "7.1";

/** Vote → human-readable review state (Azure reviewer votes are a fixed enum). */
function voteToState(vote: number): string {
  switch (vote) {
    case 10:
      return "approved";
    case 5:
      return "approved with suggestions";
    case -5:
      return "waiting for author";
    case -10:
      return "rejected";
    default:
      return "none";
  }
}

const CLOSED_WORK_ITEM_STATES = new Set([
  "closed",
  "done",
  "resolved",
  "removed",
  "completed",
]);

// ---- Raw API response shapes (carefully typed; parsed JSON only touched here) ----

interface RawIdentity {
  displayName?: string;
  uniqueName?: string;
}

interface RawReviewer {
  displayName?: string;
  vote?: number;
}

interface RawPullRequest {
  pullRequestId: number;
  title: string;
  description?: string | null;
  status: string;
  createdBy?: RawIdentity | null;
  creationDate: string;
  closedDate?: string | null;
  sourceRefName?: string;
  targetRefName?: string;
  reviewers?: ReadonlyArray<RawReviewer>;
  repository?: { webUrl?: string } | null;
}

interface RawThreadComment {
  id?: number;
  content?: string | null;
  author?: RawIdentity | null;
  publishedDate?: string;
  commentType?: string;
}

interface RawThread {
  id: number;
  lastUpdatedDate?: string;
  comments?: ReadonlyArray<RawThreadComment>;
}

interface RawWorkItemFields {
  "System.Title"?: string;
  "System.State"?: string;
  "System.WorkItemType"?: string;
  "System.CreatedBy"?: RawIdentity | string | null;
  "System.CreatedDate"?: string;
  "System.ChangedDate"?: string;
}

interface RawWorkItem {
  id: number;
  fields?: RawWorkItemFields;
  _links?: { html?: { href?: string } };
}

interface RawListEnvelope<T> {
  value?: ReadonlyArray<T>;
}

interface RawWiqlResult {
  workItems?: ReadonlyArray<{ id: number }>;
}

export class AzureClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: AzureClientOptions = {}) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://dev.azure.com";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "statewave-connectors-azure-devops";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "azure-devops",
      });
    }
  }

  private orgBase(repo: AzureRepoRef): string {
    return `${this.baseUrl}/${repo.organization}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.token) {
      const basic =
        typeof Buffer !== "undefined"
          ? Buffer.from(`:${this.token}`).toString("base64")
          : btoa(`:${this.token}`);
      headers.Authorization = `Basic ${basic}`;
    }
    return headers;
  }

  private async handleErrors(res: Response): Promise<void> {
    if (res.status === 401) {
      throw new ConnectorError("azure devops auth failed (401)", {
        code: "auth_failed",
        connector: "azure-devops",
        hint: "set AZURE_DEVOPS_PAT with Code:Read and Work Items:Read scopes",
      });
    }
    if (res.status === 403) {
      throw new ConnectorError("azure devops permission denied (403)", {
        code: "permission_denied",
        connector: "azure-devops",
        hint: "the PAT lacks the required scopes for this resource",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError("azure devops resource not found", {
        code: "not_found",
        connector: "azure-devops",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError("azure devops rate limit exceeded", {
        code: "rate_limited",
        connector: "azure-devops",
        retryable: true,
      });
    }
    // Azure returns a 203 (or 200) HTML sign-in page when auth is wrong rather
    // than a clean 401. Detect the HTML body and surface it as an auth failure.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      throw new ConnectorError("azure devops returned an HTML sign-in page", {
        code: "auth_failed",
        connector: "azure-devops",
        hint: "PAT is missing or invalid — Azure DevOps served its sign-in page instead of JSON",
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`azure devops request failed: ${res.status}`, {
        code: "network",
        connector: "azure-devops",
        retryable: res.status >= 500,
      });
    }
  }

  private async request<T>(repo: AzureRepoRef, path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.orgBase(repo)}${path}`, {
      headers: this.headers(),
    });
    await this.handleErrors(res);
    return (await res.json()) as T;
  }

  private async postJson<T>(repo: AzureRepoRef, path: string, body: unknown): Promise<T> {
    const headers = this.headers();
    headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(`${this.orgBase(repo)}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    await this.handleErrors(res);
    return (await res.json()) as T;
  }

  async listPullRequests(repo: AzureRepoRef): Promise<ReadonlyArray<AzurePullRequest>> {
    const path =
      `/${repo.project}/_apis/git/repositories/${repo.repository}/pullrequests` +
      `?searchCriteria.status=all&$top=100&api-version=${API_VERSION}`;
    const env = await this.request<RawListEnvelope<RawPullRequest>>(repo, path);
    const items = env.value ?? [];
    return items.map((raw) => this.toPullRequest(raw, repo));
  }

  async listPrComments(
    repo: AzureRepoRef,
    prId: number,
  ): Promise<ReadonlyArray<AzureComment>> {
    const path =
      `/${repo.project}/_apis/git/repositories/${repo.repository}/pullRequests/${prId}/threads` +
      `?api-version=${API_VERSION}`;
    const env = await this.request<RawListEnvelope<RawThread>>(repo, path);
    const threads = env.value ?? [];
    const out: AzureComment[] = [];
    for (const thread of threads) {
      const comments = thread.comments ?? [];
      for (const c of comments) {
        if (c.commentType === "system") continue;
        const content = c.content ?? "";
        if (!content.trim()) continue;
        out.push({
          type: "comment",
          pr_id: prId,
          thread_id: thread.id,
          id: c.id ?? 0,
          content,
          author: c.author ? { displayName: c.author.displayName } : null,
          publishedDate: c.publishedDate ?? thread.lastUpdatedDate ?? new Date().toISOString(),
          html_url: `https://dev.azure.com/${repo.organization}/${repo.project}/_git/${repo.repository}/pullrequest/${prId}`,
        });
      }
    }
    return out;
  }

  /** Reviews are derived synchronously from an already-fetched PR's reviewers. */
  reviewsFromPr(pr: AzurePullRequest): ReadonlyArray<AzureReview> {
    const occurred = pr.closedDate ?? pr.creationDate;
    const out: AzureReview[] = [];
    pr.reviewers.forEach((reviewer, index) => {
      if (reviewer.vote === 0) return;
      out.push({
        type: "review",
        pr_id: pr.pullRequestId,
        reviewer_index: index,
        reviewer: { displayName: reviewer.displayName },
        vote: reviewer.vote,
        state: voteToState(reviewer.vote),
        occurred_at: occurred,
        html_url: pr.html_url,
      });
    });
    return out;
  }

  async listWorkItems(
    repo: AzureRepoRef,
    params: { since?: string } = {},
  ): Promise<ReadonlyArray<AzureWorkItem>> {
    let query =
      "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project";
    if (params.since) {
      // WIQL date literals use the 'YYYY-MM-DD' form.
      const day = params.since.slice(0, 10);
      query += ` AND [System.ChangedDate] >= '${day}'`;
    }
    query += " ORDER BY [System.ChangedDate] DESC";

    const wiql = await this.postJson<RawWiqlResult>(
      repo,
      `/${repo.project}/_apis/wit/wiql?api-version=${API_VERSION}`,
      { query },
    );
    const ids = (wiql.workItems ?? []).map((w) => w.id);
    if (ids.length === 0) return [];

    const fields = [
      "System.Id",
      "System.Title",
      "System.State",
      "System.WorkItemType",
      "System.CreatedBy",
      "System.CreatedDate",
      "System.ChangedDate",
    ].join(",");

    const out: AzureWorkItem[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const path =
        `/_apis/wit/workitems?ids=${batch.join(",")}` +
        `&$fields=${fields}&api-version=${API_VERSION}`;
      const env = await this.request<RawListEnvelope<RawWorkItem>>(repo, path);
      const items = env.value ?? [];
      for (const raw of items) {
        out.push(this.toWorkItem(raw, repo));
      }
    }
    return out;
  }

  private toPullRequest(raw: RawPullRequest, repo: AzureRepoRef): AzurePullRequest {
    const webUrl = raw.repository?.webUrl;
    const html_url = webUrl
      ? `${webUrl}/pullrequest/${raw.pullRequestId}`
      : `https://dev.azure.com/${repo.organization}/${repo.project}/_git/${repo.repository}/pullrequest/${raw.pullRequestId}`;
    const reviewers = (raw.reviewers ?? []).map((r) => ({
      displayName: r.displayName,
      vote: r.vote ?? 0,
    }));
    return {
      type: "pull_request",
      pullRequestId: raw.pullRequestId,
      title: raw.title,
      description: raw.description ?? null,
      status: raw.status,
      merged: raw.status === "completed",
      createdBy: raw.createdBy
        ? { displayName: raw.createdBy.displayName, uniqueName: raw.createdBy.uniqueName }
        : null,
      creationDate: raw.creationDate,
      closedDate: raw.closedDate ?? null,
      sourceRefName: raw.sourceRefName,
      targetRefName: raw.targetRefName,
      reviewers,
      html_url,
    };
  }

  private toWorkItem(raw: RawWorkItem, repo: AzureRepoRef): AzureWorkItem {
    const fields = raw.fields ?? {};
    const createdByRaw = fields["System.CreatedBy"];
    let createdBy: AzureWorkItem["createdBy"] = null;
    if (typeof createdByRaw === "string") {
      createdBy = { displayName: createdByRaw };
    } else if (createdByRaw) {
      createdBy = { displayName: createdByRaw.displayName, uniqueName: createdByRaw.uniqueName };
    }
    const state = fields["System.State"] ?? "";
    const closed = CLOSED_WORK_ITEM_STATES.has(state.toLowerCase());
    const href = raw._links?.html?.href;
    const html_url =
      href ??
      `https://dev.azure.com/${repo.organization}/${repo.project}/_workitems/edit/${raw.id}`;
    return {
      type: "work_item",
      id: raw.id,
      title: fields["System.Title"] ?? "",
      state,
      workItemType: fields["System.WorkItemType"] ?? "",
      createdBy,
      createdDate: fields["System.CreatedDate"] ?? new Date().toISOString(),
      changedDate: fields["System.ChangedDate"] ?? fields["System.CreatedDate"] ?? new Date().toISOString(),
      closed,
      html_url,
    };
  }
}

export function parseRepoRef(spec: string): AzureRepoRef {
  const parts = spec.split("/");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new ConnectorError(`invalid repo "${spec}", expected organization/project/repository`, {
      code: "config_invalid",
      connector: "azure-devops",
      hint: "expected organization/project/repository",
    });
  }
  return { organization: parts[0], project: parts[1], repository: parts[2] };
}
