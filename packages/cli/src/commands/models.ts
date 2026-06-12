/**
 * Live model discovery for the memory-engine prompt.
 *
 * Hardcoded model names go stale: a default like `gpt-4o-mini` can be deprecated
 * and removed, yet a pinned list would keep offering it as "best". So whenever we
 * have credentials we ask the PROVIDER which models it currently serves and pick
 * the default from that live list — a removed model literally can't appear, so we
 * can never recommend a deprecated one. The curated preference order below is only
 * a tie-breaker among models that actually exist; if a favorite is gone, it's
 * skipped in favor of the newest live model. When the API can't be reached we fall
 * back to the provider's built-in default and say so — offline stays first-class.
 */
import type { ProviderDef } from "./providers.js";

export interface ModelCatalog {
  /** LiteLLM-form model ids, ranked best-first (deduped). */
  models: string[];
  /** Suggested default (LiteLLM form). Always one of `models` when live. */
  recommended?: string;
  source: "live" | "fallback";
  /** Why we fell back (never contains the API key). */
  note?: string;
}

/**
 * Curated preference PATTERNS per provider, best-first. Patterns (not exact ids)
 * so they survive date-stamped ids like `claude-3-5-haiku-20241022`. Used ONLY to
 * rank among models that exist in the live list — never as the source of truth —
 * so a deprecated favorite is skipped rather than recommended. Fast/cheap families
 * lead (mini / haiku / flash): the compiler job is high-volume fact extraction,
 * and within a preferred family the newest model wins on the recency tie-break.
 */
export const MODEL_PREFERENCE: Record<string, RegExp[]> = {
  openai: [/gpt-4o-mini/i, /o[34]-mini/i, /gpt-4\.1-mini/i, /gpt-4o\b/i, /gpt-4\.1/i],
  anthropic: [/haiku/i, /sonnet/i, /opus/i],
  gemini: [/flash-lite/i, /flash/i, /pro/i],
  ollama: [],
  "openai-compatible": [],
  custom: [],
};

interface Candidate {
  id: string; // LiteLLM-form
  ts: number; // recency (epoch ms), 0 when unknown
  chat: boolean; // a text-generation model (not embeddings/audio/image)
}

export interface ListModelsOpts {
  apiKey?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Query a provider for the models it currently serves, ranked best-first. */
export async function listProviderModels(provider: ProviderDef, opts: ListModelsOpts = {}): Promise<ModelCatalog> {
  const fallback: ModelCatalog = {
    models: provider.defaultModel ? [provider.defaultModel] : [],
    recommended: provider.defaultModel || undefined,
    source: "fallback",
  };
  if (provider.id === "custom") return fallback; // freeform — nothing to list
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  try {
    const candidates = await fetchCandidates(provider, opts, f, timeoutMs);
    if (!candidates || candidates.length === 0) {
      return { ...fallback, note: `couldn't list models from ${provider.label}` };
    }
    const ranked = rankCandidates(provider.id, candidates);
    if (ranked.length === 0) return { ...fallback, note: `no text models returned by ${provider.label}` };
    return { models: ranked, recommended: ranked[0], source: "live" };
  } catch (err) {
    // Never surface the key; network/HTTP message only.
    return { ...fallback, note: `couldn't reach ${provider.label} (${(err as Error).message})` };
  }
}

async function fetchCandidates(
  provider: ProviderDef,
  opts: ListModelsOpts,
  f: typeof fetch,
  timeoutMs: number,
): Promise<Candidate[] | null> {
  const base = (opts.apiBase ?? "").replace(/\/+$/, "");
  switch (provider.id) {
    case "openai": {
      const root = base || "https://api.openai.com";
      const data = await getJson(`${root}/v1/models`, { Authorization: `Bearer ${opts.apiKey}` }, f, timeoutMs);
      return asArray(data?.data).map((m) => ({
        id: String(m.id),
        ts: Number(m.created) ? Number(m.created) * 1000 : 0,
        chat: isOpenAiChat(String(m.id)),
      }));
    }
    case "openai-compatible": {
      if (!base) return null;
      const headers: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
      const data = await getJson(`${base}/v1/models`, headers, f, timeoutMs);
      return asArray(data?.data).map((m) => ({
        id: `openai/${String(m.id)}`,
        ts: Number(m.created) ? Number(m.created) * 1000 : 0,
        chat: !/embed/i.test(String(m.id)),
      }));
    }
    case "anthropic": {
      const data = await getJson(
        "https://api.anthropic.com/v1/models?limit=100",
        { "x-api-key": String(opts.apiKey), "anthropic-version": "2023-06-01" },
        f,
        timeoutMs,
      );
      return asArray(data?.data).map((m) => ({
        id: `anthropic/${String(m.id)}`,
        ts: Date.parse(m.created_at ?? "") || 0,
        chat: /^claude/i.test(String(m.id)),
      }));
    }
    case "gemini": {
      // Key travels as a query param; we never log the URL.
      const data = await getJson(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(String(opts.apiKey))}`,
        {},
        f,
        timeoutMs,
      );
      return asArray(data?.models).map((m) => {
        const name = String(m.name ?? "").replace(/^models\//, "");
        const methods: string[] = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        return {
          id: `gemini/${name}`,
          ts: 0, // Gemini gives no timestamp — version heuristic orders these
          chat: methods.includes("generateContent") && !/embedding|aqa|imagen|veo/i.test(name),
        };
      });
    }
    case "ollama": {
      const root = base || "http://localhost:11434";
      const data = await getJson(`${root}/api/tags`, {}, f, timeoutMs);
      return asArray(data?.models).map((m) => {
        const name = String(m.name ?? "").replace(/:latest$/, "");
        return {
          id: `ollama/${name}`,
          ts: Date.parse(m.modified_at ?? "") || 0,
          chat: !/embed/i.test(name),
        };
      });
    }
    default:
      return null;
  }
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  f: typeof fetch,
  timeoutMs: number,
): Promise<{ [k: string]: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await f(url, { headers, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { [k: string]: unknown };
  } finally {
    clearTimeout(timer);
  }
}

function asArray(v: unknown): Array<{ [k: string]: any }> {
  return Array.isArray(v) ? (v as Array<{ [k: string]: any }>) : [];
}

/** OpenAI text-chat models only — exclude embeddings/audio/image/legacy. */
function isOpenAiChat(id: string): boolean {
  if (!/^(gpt-|o[1-9]|chatgpt)/i.test(id)) return false;
  return !/embedding|whisper|tts|dall-e|audio|realtime|image|moderation|transcribe|instruct|search|babbage|davinci/i.test(
    id,
  );
}

/** First decimal number in an id (e.g. gemini-2.0-flash → 2.0), for tie-breaking. */
function versionScore(id: string): number {
  const m = id.match(/(\d+(?:\.\d+)?)/);
  return m ? Number.parseFloat(m[1]!) : 0;
}

/**
 * Rank live models best-first: curated preferences that EXIST come first (in
 * preference order), then everything else newest-first (timestamp, then version
 * number). The top of this list is the recommended default — guaranteed to be a
 * model the provider currently serves.
 */
export function rankCandidates(providerId: string, candidates: Candidate[]): string[] {
  const pref = MODEL_PREFERENCE[providerId] ?? [];
  const prefIndex = (id: string): number => {
    const i = pref.findIndex((re) => re.test(id));
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const chat = candidates.filter((c) => c.chat && c.id);
  chat.sort((a, b) => {
    const pa = prefIndex(a.id);
    const pb = prefIndex(b.id);
    if (pa !== pb) return pa - pb;
    if (b.ts !== a.ts) return b.ts - a.ts;
    return versionScore(b.id) - versionScore(a.id);
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chat) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      out.push(c.id);
    }
  }
  return out;
}

/**
 * Resolve a user's answer at the model prompt: empty → the recommended default;
 * a number → that 1-based entry in the shown list; anything else → a literal
 * model id the user typed (always allowed, so new ids work the day they ship).
 */
export function resolveModelAnswer(answer: string, shown: string[], recommended: string): string {
  const t = answer.trim();
  if (t === "") return recommended;
  if (/^\d+$/.test(t)) {
    const n = Number.parseInt(t, 10);
    if (n >= 1 && n <= shown.length) return shown[n - 1]!;
  }
  return t;
}
