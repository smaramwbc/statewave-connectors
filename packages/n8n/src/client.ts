// Minimal client for n8n's REST API. We hit two endpoints:
//
//   GET /api/v1/workflows                  — workflow id → name resolution
//   GET /api/v1/executions?workflowId=…&includeData=true   — runtime signal
//
// Authentication is `X-N8N-API-KEY` (an API key created inside the n8n UI).
// The connector treats the key as read-only — there are no write paths in
// this client.

import { ConnectorError } from "@statewavedev/connectors-core";
import type { N8nExecution, N8nWorkflow } from "./types.js";

const DEFAULT_PAGE_LIMIT = 100;

export interface N8nClientOptions {
  /** Base URL of the n8n instance, e.g. `https://n8n.example.com`. */
  baseUrl: string;
  /** API key minted via the n8n UI (Settings → API). Required. */
  apiKey: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface N8nListResponse<T> {
  data: ReadonlyArray<T>;
  nextCursor?: string | null;
}

export class N8nClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: N8nClientOptions) {
    if (!options.apiKey) {
      throw new ConnectorError("N8N_API_KEY is required for the n8n connector", {
        code: "auth_missing",
        connector: "n8n",
        hint: "create an API key in n8n: Settings → API → Create new API key",
      });
    }
    if (!options.baseUrl) {
      throw new ConnectorError("N8N_INSTANCE_URL is required for the n8n connector", {
        code: "config_invalid",
        connector: "n8n",
        hint: "set N8N_INSTANCE_URL or pass baseUrl, e.g. https://n8n.example.com",
      });
    }
    // Strip a trailing slash so we can concatenate `/api/v1/...` cleanly.
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "statewave-connectors-n8n";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "n8n",
      });
    }
  }

  /** A no-op-ish health probe — fetches the workflows endpoint with limit=1
   * so `check()` can report the auth + connectivity state without paging. */
  async ping(): Promise<void> {
    await this.callJson<N8nListResponse<N8nWorkflow>>(`/api/v1/workflows?limit=1`);
  }

  /** Fetch every workflow in the instance. n8n caps page size around 250;
   * we page until exhausted because workflow lists are typically small. */
  async listWorkflows(): Promise<ReadonlyArray<N8nWorkflow>> {
    const out: N8nWorkflow[] = [];
    let cursor: string | undefined;
    do {
      const path = cursor
        ? `/api/v1/workflows?limit=${DEFAULT_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
        : `/api/v1/workflows?limit=${DEFAULT_PAGE_LIMIT}`;
      const r = await this.callJson<N8nListResponse<N8nWorkflow>>(path);
      for (const w of r.data) out.push(w);
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    return out;
  }

  /**
   * Fetch executions for a workflow, optionally filtered by `since`. We
   * always pass `includeData=true` so per-node errors can be extracted from
   * `execution.data.resultData.runData`.
   *
   * n8n returns executions newest-first; we reverse so callers see history
   * in chronological order (matches every other connector in this repo).
   */
  async listExecutions(
    workflowId: string,
    options: { since?: string } = {},
  ): Promise<ReadonlyArray<N8nExecution>> {
    const out: N8nExecution[] = [];
    let cursor: string | undefined;
    const sinceMs = options.since ? new Date(options.since).getTime() : undefined;

    do {
      const params = new URLSearchParams({
        workflowId,
        limit: String(DEFAULT_PAGE_LIMIT),
        includeData: "true",
      });
      if (cursor) params.set("cursor", cursor);
      const r = await this.callJson<N8nListResponse<N8nExecution>>(
        `/api/v1/executions?${params.toString()}`,
      );
      let stop = false;
      for (const e of r.data) {
        if (sinceMs !== undefined) {
          const startedMs = new Date(e.startedAt).getTime();
          if (Number.isFinite(startedMs) && startedMs < sinceMs) {
            // Past the window — stop paging. n8n returns newest-first.
            stop = true;
            break;
          }
        }
        out.push(e);
      }
      if (stop) break;
      cursor = r.nextCursor ?? undefined;
    } while (cursor);

    return out.reverse();
  }

  // -- internals -----------------------------------------------------------

  private async callJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        "X-N8N-API-KEY": this.apiKey,
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
    });

    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError(`n8n ${path} returned HTTP ${res.status}`, {
        code: "auth_failed",
        connector: "n8n",
        hint: "verify N8N_API_KEY is valid and the user it belongs to has read access",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError(`n8n ${path} rate-limited (HTTP 429)`, {
        code: "rate_limited",
        connector: "n8n",
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`n8n ${path} returned HTTP ${res.status}`, {
        code: "network",
        connector: "n8n",
      });
    }
    return (await res.json()) as T;
  }
}
