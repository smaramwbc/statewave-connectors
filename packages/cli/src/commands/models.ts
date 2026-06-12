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
  /**
   * Why a live list wasn't produced. "auth" means the key was rejected (wrong /
   * expired) — the caller should re-ask the key, not proceed. "network" means we
   * couldn't reach the provider (key unverified, proceed with a warning).
   */
  reason?: "auth" | "network" | "empty";
  /** Human note (never contains the API key). */
  note?: string;
}

/**
 * Quality/cost tiers for the compiler default, by cross-provider KEYWORDS rather
 * than hardcoded model names (names go stale and would suppress newer
 * generations). Lower tier = better default. Within a tier the NEWEST model wins
 * on recency — so the latest generation's standard-small model surfaces (gpt-5-mini
 * today, a future gpt-6-mini automatically), with the full list following.
 */
const STANDARD_SMALL = /(^|[-/])(mini|flash|haiku)([-./:]|$)/i; // best balance for high-volume extraction
const ULTRA_SMALL = /(^|[-/])(nano|lite|small)([-./:]|$)/i; // ultra-cheap, lower quality
/** OpenAI o-series are reasoning models — "mini" but not cheap-per-task. */
const REASONING = /^o\d/i;

function tierRank(id: string): number {
  const bare = id.replace(/^[^/]+\//, ""); // drop a provider prefix before the o-series check
  if (REASONING.test(bare)) return 3; // reasoning: capable but costly per task — not the default
  if (STANDARD_SMALL.test(id)) return 0; // mini / flash / haiku
  if (ULTRA_SMALL.test(id)) return 1; // nano / lite / small
  return 2; // flagships and everything else
}

/**
 * Known-superseded families some providers still LIST but shouldn't be offered as
 * a current default. Conservative on purpose — only families that are unambiguously
 * legacy, so new models never match and can't be wrongly hidden.
 */
const LEGACY: Record<string, RegExp[]> = {
  openai: [/gpt-3\.5/i, /gpt-4-turbo/i, /^gpt-4(-\d|$)/i, /gpt-4-32k/i, /(^|-)(davinci|babbage|ada|curie)(-|$)/i],
  "openai-compatible": [],
  anthropic: [/claude-(1|2|instant)/i],
  gemini: [/gemini-1\.0|gemini-pro-vision|bison|gecko/i],
  ollama: [],
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
      return { ...fallback, reason: "empty", note: `couldn't list models from ${provider.label}` };
    }
    const ranked = rankCandidates(provider.id, candidates);
    if (ranked.length === 0) return { ...fallback, reason: "empty", note: `no text models returned by ${provider.label}` };
    return { models: ranked, recommended: ranked[0], source: "live" };
  } catch (err) {
    // Classify so the caller can re-ask a rejected key but proceed past a
    // transient network error. Never surface the key — HTTP status / message only.
    const { reason, note } = classifyFailure(err);
    return { ...fallback, reason, note: `${provider.label}: ${note}` };
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
  }
}

/** Auth failure (re-ask the key) vs network failure (unverified, proceed). */
function classifyFailure(err: unknown): { reason: "auth" | "network"; note: string } {
  if (err instanceof HttpError) {
    const authStatus = err.status === 401 || err.status === 403;
    const authBody = /invalid.*api.?key|api.?key.*(not valid|invalid|expired)|incorrect api key|unauthor|expired/i.test(
      err.body,
    );
    if (authStatus || authBody) return { reason: "auth", note: `key rejected (HTTP ${err.status})` };
    return { reason: "network", note: `HTTP ${err.status}` };
  }
  return { reason: "network", note: (err as Error).message };
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
    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 500);
      } catch {
        // body is best-effort; status alone still classifies most failures
      }
      throw new HttpError(res.status, body);
    }
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

/** Strip a trailing date pin: -2024-07-18 (OpenAI) or -20241022 (Anthropic). */
function stripDate(id: string): string {
  return id.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

/**
 * Rank live models best-first: curated preferences that EXIST come first (in
 * preference order), then everything else newest-first (timestamp, then version
 * number). The top of this list is the recommended default — guaranteed to be a
 * model the provider currently serves.
 */
export function rankCandidates(providerId: string, candidates: Candidate[]): string[] {
  const legacy = LEGACY[providerId] ?? [];
  const kept = candidates.filter((c) => c.chat && c.id && !legacy.some((re) => re.test(c.id)));
  // Collapse dated snapshots: when a floating alias (gpt-4o-mini) and its dated
  // pin (gpt-4o-mini-2024-07-18) both appear, keep only the alias — the alias
  // always tracks the newest snapshot, so the list stays current and uncluttered.
  const ids = new Set(kept.map((c) => c.id));
  const chat = kept.filter((c) => {
    const base = stripDate(c.id);
    return base === c.id || !ids.has(base);
  });
  // Quality/cost tier first; within each tier the NEWEST model (recency, then
  // version) — so the latest generation's standard-small model is the
  // recommendation, and the full current list (incl. flagships) follows. No model
  // name is pinned, so newer generations rank correctly the day they ship.
  chat.sort((a, b) => {
    const ta = tierRank(a.id);
    const tb = tierRank(b.id);
    if (ta !== tb) return ta - tb;
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
