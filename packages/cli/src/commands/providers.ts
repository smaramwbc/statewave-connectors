/**
 * LiteLLM provider / model configuration for the memory engine.
 *
 * The Statewave server is provider-neutral: `server/services/compilers/llm.py`
 * and `server/services/embeddings/litellm.py` call LiteLLM with the model id
 * from `STATEWAVE_LITELLM_MODEL` (the provider is encoded in the model prefix —
 * `anthropic/…`, `gemini/…`, `ollama/…`, plain `gpt-…` for OpenAI), an
 * `STATEWAVE_LITELLM_API_KEY`, an optional `STATEWAVE_LITELLM_API_BASE`, and a
 * separate `STATEWAVE_LITELLM_EMBEDDING_MODEL`.
 *
 * Compiler and embeddings are configured INDEPENDENTLY. That matters: some
 * providers (Anthropic) ship no embedding endpoint, so we keep the LLM compiler
 * but set `STATEWAVE_EMBEDDING_PROVIDER=stub` (keyword retrieval) unless the
 * user supplies a separate embedding model. We never claim semantic retrieval a
 * provider can't actually do.
 *
 * Model lists are intentionally small + overridable — they go stale, so the
 * flow always allows a custom LiteLLM model id rather than pinning names.
 */

export interface ProviderDef {
  id: string;
  label: string;
  /** Default completion model (already in LiteLLM form). */
  defaultModel: string;
  /** Default embedding model, or null when the provider has no embeddings. */
  defaultEmbeddingModel: string | null;
  /** Requires an API base URL (Ollama, OpenAI-compatible). */
  needsApiBase: boolean;
  /** Pre-filled API base when there's a conventional default (Ollama). */
  defaultApiBase?: string;
  /** Whether an API key is expected (Ollama local needs none). */
  needsApiKey: boolean;
}

export const PROVIDERS: ReadonlyArray<ProviderDef> = [
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    defaultEmbeddingModel: "text-embedding-3-small",
    needsApiBase: false,
    needsApiKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "anthropic/claude-3-5-haiku-latest",
    defaultEmbeddingModel: null, // Anthropic has no embeddings endpoint
    needsApiBase: false,
    needsApiKey: true,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini/gemini-1.5-flash",
    defaultEmbeddingModel: "gemini/text-embedding-004",
    needsApiBase: false,
    needsApiKey: true,
  },
  {
    id: "ollama",
    label: "Ollama (local models)",
    defaultModel: "ollama/llama3.1",
    defaultEmbeddingModel: "ollama/nomic-embed-text",
    needsApiBase: true,
    defaultApiBase: "http://localhost:11434",
    needsApiKey: false,
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint",
    defaultModel: "openai/<model-name>",
    defaultEmbeddingModel: null,
    needsApiBase: true,
    needsApiKey: true,
  },
  {
    id: "custom",
    label: "Other LiteLLM model id (enter manually)",
    defaultModel: "",
    defaultEmbeddingModel: null,
    needsApiBase: false,
    needsApiKey: true,
  },
];

export function findProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export interface ProviderConfig {
  provider: string;
  /** Completion model override (LiteLLM id); falls back to the provider default. */
  model?: string;
  apiKey?: string;
  apiBase?: string;
  /** Embedding model override; falls back to the provider's, else keyword/stub. */
  embeddingModel?: string;
}

/**
 * Map a provider config to the server's `STATEWAVE_*` environment. Pure: no I/O,
 * no secrets logged. The result is passed to `docker compose up` via the
 * environment, never written to the compose file.
 */
export function buildProviderEnv(cfg: ProviderConfig): Record<string, string> {
  const p = findProvider(cfg.provider);
  const env: Record<string, string> = { STATEWAVE_COMPILER_TYPE: "llm" };

  const model = (cfg.model ?? p?.defaultModel ?? "").trim();
  if (model) env.STATEWAVE_LITELLM_MODEL = model;
  if (cfg.apiKey) env.STATEWAVE_LITELLM_API_KEY = cfg.apiKey;

  const apiBase = cfg.apiBase ?? p?.defaultApiBase;
  if (apiBase) env.STATEWAVE_LITELLM_API_BASE = apiBase;

  const embedding = cfg.embeddingModel ?? p?.defaultEmbeddingModel ?? null;
  if (embedding) {
    env.STATEWAVE_EMBEDDING_PROVIDER = "litellm";
    env.STATEWAVE_LITELLM_EMBEDDING_MODEL = embedding;
  } else {
    // Provider supplies no embeddings — keep the LLM compiler but retrieve by
    // keyword rather than pretend semantic search works.
    env.STATEWAVE_EMBEDDING_PROVIDER = "stub";
  }
  return env;
}

/** True when a provider lacks embeddings and will use keyword retrieval by default. */
export function providerLacksEmbeddings(id: string): boolean {
  const p = findProvider(id);
  return p ? p.defaultEmbeddingModel === null && p.id !== "custom" && p.id !== "openai-compatible" : false;
}
