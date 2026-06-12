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
  /** Memories created by THIS call (the sync endpoint is bounded per batch). */
  memoriesCreated?: number;
  /** Episodes still uncompiled — drain by calling again until this is 0. */
  remaining?: number;
  /** True while more batches remain; the caller should call again to finish. */
  hasMore?: boolean;
}

/**
 * Thin HTTP wrapper around the Statewave v1 API.
 *
 * The MCP-server-side type names (`StatewaveEpisode`, `MemorySearchResult`,
 * `ContextBundle`, `TimelineItem`) come from the connectors-core ecosystem,
 * which uses connector-friendly field names (`subject`, `kind`, `text`,
 * `source: SourcePointer`). The Statewave v1 HTTP API uses different field
 * names (`subject_id`, `type`, `payload`, `source: string`). Each method
 * below translates between the two so callers can keep working in the
 * connectors-core idiom while the wire payload stays valid against the live
 * server.
 *
 * Translation table (input):
 *   subject     → subject_id
 *   kind        → type
 *   query       → q (search) / task (context)
 *   text + source.{id,url} → payload object
 *   source.type → source string
 *   occurred_at → top-level occurred_at (server migration 0015)
 *
 * Translation table (output):
 *   subject_id  → subject
 *   content     → text (memories)
 *   payload.*   → text (timeline episodes — best-effort flatten)
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
    // Translate connectors-core StatewaveEpisode → server CreateEpisodeRequest.
    // `occurred_at` rides at the top level (server migration 0015 added it as
    // a first-class column with server_default=now()). The server still has
    // no first-class `idempotency_key` field, so we forward it through
    // `metadata` and surface it back unchanged — duplicate detection beyond
    // what the server does natively is best-effort.
    const wire = {
      subject_id: episode.subject,
      type: episode.kind,
      source: episode.source.type,
      occurred_at: episode.occurred_at,
      payload: {
        text: episode.text,
        ...(episode.source.id ? { source_id: episode.source.id } : {}),
        ...(episode.source.url ? { source_url: episode.source.url } : {}),
      },
      metadata: {
        ...(episode.metadata ?? {}),
        idempotency_key: episode.idempotency_key,
      },
    };
    const response = await this.request<{ id?: string }>("POST", "/v1/episodes", wire);
    return {
      id: response.id,
      idempotency_key: episode.idempotency_key,
      duplicate: false,
    };
  }

  async searchMemories(input: {
    query: string;
    subject?: string;
    limit?: number;
  }): Promise<ReadonlyArray<MemorySearchResult>> {
    if (!input.subject) {
      // The server's /v1/memories/search requires subject_id. Surface this
      // as a config error so the LLM client can reprompt cleanly instead
      // of getting a 422 it can't parse.
      throw new ConnectorError("statewave_search_memories requires subject", {
        code: "config_invalid",
        hint: "the Statewave server scopes memory search to a single subject",
      });
    }
    const qs = new URLSearchParams();
    qs.set("subject_id", input.subject);
    qs.set("q", input.query);
    if (input.limit) qs.set("limit", String(input.limit));
    const response = await this.request<{ memories: ReadonlyArray<RawMemory> }>(
      "GET",
      `/v1/memories/search?${qs.toString()}`,
    );
    return response.memories.map(toMemorySearchResult);
  }

  async getContext(input: {
    subject: string;
    query?: string;
    max_tokens?: number;
  }): Promise<ContextBundle> {
    if (!input.query) {
      throw new ConnectorError("statewave_get_context requires query (the task being performed)", {
        code: "config_invalid",
        hint: "the server uses the task to rank facts and procedures",
      });
    }
    const wire = {
      subject_id: input.subject,
      task: input.query,
      ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
    };
    const response = await this.request<RawContextBundle>("POST", "/v1/context", wire);
    // Merge facts + procedures into a flat `memories` list for the
    // connectors-core ContextBundle shape, while passing the assembled
    // string verbatim so the LLM can read it directly.
    const memories: MemorySearchResult[] = [
      ...(response.facts ?? []).map(toMemorySearchResult),
      ...(response.procedures ?? []).map(toMemorySearchResult),
    ];
    return {
      subject: response.subject_id ?? input.subject,
      assembled_context: response.assembled_context ?? "",
      token_estimate: response.token_estimate,
      memories,
    };
  }

  async getTimeline(input: {
    subject: string;
    since?: string;
    until?: string;
    kinds?: ReadonlyArray<string>;
    limit?: number;
  }): Promise<ReadonlyArray<TimelineItem>> {
    const qs = new URLSearchParams();
    qs.set("subject_id", input.subject);
    if (input.since) qs.set("since", input.since);
    if (input.until) qs.set("until", input.until);
    if (input.limit) qs.set("limit", String(input.limit));
    if (input.kinds && input.kinds.length > 0) qs.set("kinds", input.kinds.join(","));
    const response = await this.request<{ subject_id: string; episodes: ReadonlyArray<RawEpisode> }>(
      "GET",
      `/v1/timeline?${qs.toString()}`,
    );
    return response.episodes.map((ep) => toTimelineItem(ep, response.subject_id));
  }

  async compileSubject(input: { subject: string; force?: boolean }): Promise<CompileSummary> {
    // The server takes `async` (default false) — synchronous compile is the
    // conservative default and matches what the bootstrap script does. We
    // ignore `force` because the server doesn't expose a force-recompile
    // flag yet; recompilation happens automatically on subsequent compile
    // calls when episodes have changed.
    const wire = { subject_id: input.subject, async: false };
    void input.force;
    const response = await this.request<{
      subject_id?: string;
      status?: string;
      job_id?: string;
      memories_created?: number;
      has_more?: boolean;
      remaining_episodes?: number;
    }>("POST", "/v1/memories/compile", wire);
    return {
      subject: response.subject_id ?? input.subject,
      status: (response.status as CompileSummary["status"]) ?? "succeeded",
      job_id: response.job_id,
      memoriesCreated: response.memories_created ?? 0,
      remaining: response.remaining_episodes ?? 0,
      hasMore: response.has_more ?? false,
    };
  }

  /**
   * List known subjects with their authoritative `memory_count` /
   * `episode_count`. The server has no per-subject lookup, so callers
   * paginate (`limit ≤ 200`, default 50) until they find the row they want
   * — a single page is enough for any realistic single-user IDE setup.
   */
  async listSubjects(input: { limit?: number; offset?: number } = {}): Promise<{
    subjects: ReadonlyArray<{ subject_id: string; episode_count: number; memory_count: number }>;
    total: number;
  }> {
    const qs = new URLSearchParams();
    if (input.limit) qs.set("limit", String(input.limit));
    if (input.offset) qs.set("offset", String(input.offset));
    const path = qs.toString() ? `/v1/subjects?${qs}` : "/v1/subjects";
    const response = await this.request<{
      subjects: Array<{ subject_id: string; episode_count: number; memory_count: number }>;
      total: number;
    }>("GET", path);
    return { subjects: response.subjects ?? [], total: response.total ?? 0 };
  }
}

// ---- internal raw types — kept private; callers see the connectors-core shapes ----

interface RawMemory {
  id: string;
  subject_id: string;
  kind?: string;
  content?: string;
  summary?: string;
  score?: number;
}

interface RawEpisode {
  id: string;
  subject_id: string;
  type: string;
  payload?: Record<string, unknown>;
  occurred_at?: string;
  created_at?: string;
}

interface RawContextBundle {
  subject_id?: string;
  task?: string;
  assembled_context?: string;
  token_estimate?: number;
  facts?: ReadonlyArray<RawMemory>;
  procedures?: ReadonlyArray<RawMemory>;
  episodes?: ReadonlyArray<RawEpisode>;
}

function toMemorySearchResult(m: RawMemory): MemorySearchResult {
  // Server splits content (the actual fact text) from summary (a one-liner).
  // We pick content first because that's what an agent's prompt should ground
  // on; if it's missing for some kind, fall back to the summary so we never
  // emit an empty `text`.
  return {
    id: m.id,
    subject: m.subject_id,
    kind: m.kind,
    text: m.content ?? m.summary ?? "",
    score: m.score,
  };
}

function toTimelineItem(ep: RawEpisode, subjectId: string): TimelineItem {
  // Episodes carry their content in `payload.text` when produced by the
  // standard connectors. Fall back to a JSON dump of the payload if no text
  // field is present — better to surface something than to emit blank.
  const payloadText = (ep.payload && typeof ep.payload.text === "string"
    ? (ep.payload.text as string)
    : ep.payload
      ? JSON.stringify(ep.payload).slice(0, 500)
      : "") as string;
  return {
    id: ep.id,
    subject: ep.subject_id ?? subjectId,
    kind: ep.type,
    text: payloadText,
    occurred_at: ep.occurred_at ?? ep.created_at ?? "",
  };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
