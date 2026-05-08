import { ConnectorError, type StatewaveEpisode } from "@statewavedev/connectors-core";

export interface StatewaveClientOptions {
  url: string;
  apiKey?: string;
  tenantId?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export interface IngestResponse {
  id?: string;
  idempotency_key: string;
  duplicate?: boolean;
}

export interface MemorySearchResult {
  id: string;
  subject: string;
  kind?: string;
  text: string;
  score?: number;
}

export interface ContextBundle {
  subject: string;
  assembled_context: string;
  token_estimate?: number;
  memories?: ReadonlyArray<MemorySearchResult>;
}

export interface TimelineItem {
  id: string;
  subject: string;
  kind: string;
  text: string;
  occurred_at: string;
}

export interface CompileSummary {
  subject: string;
  status: "started" | "succeeded" | "skipped" | "failed";
  job_id?: string;
}

/**
 * Thin HTTP wrapper around the Statewave v1 API. Vendor-neutral — no SDK,
 * no model provider, no IDE assumptions. The exact endpoint paths are kept
 * conservative and configurable via `pathOverrides` so they can adapt as the
 * core API evolves without re-publishing the connectors package.
 */
export class StatewaveClient {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly tenantId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: StatewaveClientOptions) {
    if (!options.url) {
      throw new ConnectorError("StatewaveClient requires a base URL", { code: "config_invalid" });
    }
    this.url = options.url.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.tenantId = options.tenantId;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "statewave-mcp-server";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
      });
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    if (this.tenantId) h["X-Tenant-ID"] = this.tenantId;
    return h;
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: this.headers() };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}${path}`, init);
    } catch (err) {
      throw new ConnectorError(
        `network error contacting Statewave at ${this.url}: ${(err as Error).message}`,
        { code: "network", retryable: true, cause: err },
      );
    }
    if (res.status === 401) {
      throw new ConnectorError("Statewave returned 401 unauthorized", {
        code: "auth_failed",
        hint: "set STATEWAVE_API_KEY or pass options.apiKey",
      });
    }
    if (res.status === 403) {
      throw new ConnectorError("Statewave returned 403 forbidden", { code: "permission_denied" });
    }
    if (res.status === 404) {
      throw new ConnectorError(`Statewave endpoint not found: ${path}`, {
        code: "not_found",
        hint: "check STATEWAVE_URL and the API version your instance exposes",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError("Statewave rate-limited the MCP request", {
        code: "rate_limited",
        retryable: true,
      });
    }
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new ConnectorError(`Statewave request failed (${res.status}): ${text}`, {
        code: res.status >= 500 ? "network" : "ingest_failed",
        retryable: res.status >= 500,
      });
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async ingestEpisode(episode: StatewaveEpisode): Promise<IngestResponse> {
    return this.request<IngestResponse>("POST", "/v1/episodes", episode);
  }

  async searchMemories(input: {
    query: string;
    subject?: string;
    limit?: number;
  }): Promise<ReadonlyArray<MemorySearchResult>> {
    const qs = new URLSearchParams();
    qs.set("query", input.query);
    if (input.subject) qs.set("subject", input.subject);
    if (input.limit) qs.set("limit", String(input.limit));
    return this.request<ReadonlyArray<MemorySearchResult>>(
      "GET",
      `/v1/memories/search?${qs.toString()}`,
    );
  }

  async getContext(input: {
    subject: string;
    query?: string;
    max_tokens?: number;
  }): Promise<ContextBundle> {
    return this.request<ContextBundle>("POST", "/v1/context", input);
  }

  async getTimeline(input: {
    subject: string;
    since?: string;
    until?: string;
    kinds?: ReadonlyArray<string>;
    limit?: number;
  }): Promise<ReadonlyArray<TimelineItem>> {
    const qs = new URLSearchParams();
    qs.set("subject", input.subject);
    if (input.since) qs.set("since", input.since);
    if (input.until) qs.set("until", input.until);
    if (input.limit) qs.set("limit", String(input.limit));
    if (input.kinds && input.kinds.length > 0) qs.set("kinds", input.kinds.join(","));
    return this.request<ReadonlyArray<TimelineItem>>("GET", `/v1/timeline?${qs.toString()}`);
  }

  async compileSubject(input: { subject: string; force?: boolean }): Promise<CompileSummary> {
    return this.request<CompileSummary>("POST", "/v1/memories/compile", input);
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
