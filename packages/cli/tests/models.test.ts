import { describe, it, expect } from "vitest";
import { listProviderModels, rankCandidates, resolveModelAnswer } from "../src/commands/models.js";
import { findProvider } from "../src/commands/providers.js";

const P = (id: string) => findProvider(id)!;

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}
function throwingFetch(message = "ECONNREFUSED"): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as typeof fetch;
}

describe("listProviderModels — OpenAI (live discovery)", () => {
  it("lists chat models newest/preferred-first, dropping embeddings/audio/legacy", async () => {
    const fetchImpl = jsonFetch({
      data: [
        { id: "gpt-4o-mini", created: 1721 },
        { id: "gpt-4o", created: 1715 },
        { id: "text-embedding-3-small", created: 1700 },
        { id: "whisper-1", created: 1690 },
        { id: "gpt-3.5-turbo-instruct", created: 1680 },
        { id: "o3-mini", created: 1730 },
      ],
    });
    const r = await listProviderModels(P("openai"), { apiKey: "sk-x", fetchImpl });
    expect(r.source).toBe("live");
    expect(r.recommended).toBe("gpt-4o-mini"); // preferred + present
    expect(r.models[0]).toBe(r.recommended);
    // filtered out:
    expect(r.models).not.toContain("text-embedding-3-small");
    expect(r.models).not.toContain("whisper-1");
    expect(r.models).not.toContain("gpt-3.5-turbo-instruct");
  });

  it("NEVER recommends a deprecated favorite that the API no longer serves", async () => {
    // gpt-4o-mini (our top preference) has been retired — it's absent from the
    // live list. The recommendation must come from what's actually available.
    const fetchImpl = jsonFetch({
      data: [
        { id: "gpt-4o", created: 1715 },
        { id: "o3-mini", created: 1730 },
        { id: "gpt-4.1-mini", created: 1740 },
      ],
    });
    const r = await listProviderModels(P("openai"), { apiKey: "sk-x", fetchImpl });
    expect(r.source).toBe("live");
    expect(r.models).not.toContain("gpt-4o-mini"); // gone
    expect(r.recommended).toBe("gpt-4.1-mini"); // next preferred family that exists
    expect(r.recommended).not.toBe("gpt-4o-mini");
  });

  it("collapses dated snapshots into the floating alias (no clutter, stays current)", async () => {
    const fetchImpl = jsonFetch({
      data: [
        { id: "gpt-4o-mini", created: 1721 },
        { id: "gpt-4o-mini-2024-07-18", created: 1721 },
        { id: "o3-mini", created: 1730 },
        { id: "o3-mini-2025-01-31", created: 1730 },
      ],
    });
    const r = await listProviderModels(P("openai"), { apiKey: "sk-x", fetchImpl });
    expect(r.models).toContain("gpt-4o-mini");
    expect(r.models).not.toContain("gpt-4o-mini-2024-07-18");
    expect(r.models).not.toContain("o3-mini-2025-01-31");
  });

  it("drops superseded families the API still lists (gpt-4-turbo, gpt-3.5, gpt-4-0613)", async () => {
    const fetchImpl = jsonFetch({
      data: [
        { id: "gpt-4o-mini", created: 1721 },
        { id: "gpt-4-turbo", created: 1700 },
        { id: "gpt-3.5-turbo", created: 1600 },
        { id: "gpt-4-0613", created: 1500 },
      ],
    });
    const r = await listProviderModels(P("openai"), { apiKey: "sk-x", fetchImpl });
    expect(r.models).toEqual(["gpt-4o-mini"]);
  });

  it("falls back to the built-in default when the API is unreachable", async () => {
    const r = await listProviderModels(P("openai"), { apiKey: "sk-x", fetchImpl: throwingFetch() });
    expect(r.source).toBe("fallback");
    expect(r.reason).toBe("network");
    expect(r.recommended).toBe("gpt-4o-mini");
    expect(r.note).toMatch(/OpenAI/);
  });

  it("falls back (with reason) on an auth error, never inventing a model", async () => {
    const r = await listProviderModels(P("openai"), { apiKey: "bad", fetchImpl: jsonFetch({}, 401) });
    expect(r.source).toBe("fallback");
    expect(r.reason).toBe("auth");
    expect(r.note).toMatch(/HTTP 401/);
  });

  it("falls back when the provider returns no models", async () => {
    const r = await listProviderModels(P("openai"), { apiKey: "sk-x", fetchImpl: jsonFetch({ data: [] }) });
    expect(r.source).toBe("fallback");
    expect(r.note).toMatch(/couldn't list models/);
  });
});

describe("listProviderModels — Anthropic / Gemini / Ollama (LiteLLM prefixes)", () => {
  it("Anthropic: prefixes anthropic/, prefers haiku, tolerates date-stamped ids", async () => {
    const fetchImpl = jsonFetch({
      data: [
        { id: "claude-3-5-haiku-20241022", created_at: "2024-10-22T00:00:00Z" },
        { id: "claude-3-7-sonnet-20250219", created_at: "2025-02-19T00:00:00Z" },
        { id: "claude-opus-4-20250101", created_at: "2025-01-01T00:00:00Z" },
      ],
    });
    const r = await listProviderModels(P("anthropic"), { apiKey: "sk-ant", fetchImpl });
    expect(r.source).toBe("live");
    expect(r.recommended).toBe("anthropic/claude-3-5-haiku-20241022");
    expect(r.models.every((m) => m.startsWith("anthropic/"))).toBe(true);
  });

  it("Gemini: keeps generateContent models, drops embeddings, prefers flash-lite", async () => {
    const fetchImpl = jsonFetch({
      models: [
        { name: "models/gemini-1.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-1.5-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-2.0-flash-lite", supportedGenerationMethods: ["generateContent"] },
      ],
    });
    const r = await listProviderModels(P("gemini"), { apiKey: "g-key", fetchImpl });
    expect(r.source).toBe("live");
    expect(r.recommended).toBe("gemini/gemini-2.0-flash-lite");
    expect(r.models).not.toContain("gemini/text-embedding-004");
    // newer flash beats older flash on the recency/version tie-break
    expect(r.models.indexOf("gemini/gemini-2.0-flash")).toBeLessThan(r.models.indexOf("gemini/gemini-1.5-flash"));
  });

  it("Ollama: lists installed tags newest-first, strips :latest, drops embeddings", async () => {
    const fetchImpl = jsonFetch({
      models: [
        { name: "llama3.1:latest", modified_at: "2024-08-01T00:00:00Z" },
        { name: "nomic-embed-text:latest", modified_at: "2024-07-01T00:00:00Z" },
        { name: "qwen2.5:7b", modified_at: "2024-09-01T00:00:00Z" },
      ],
    });
    const r = await listProviderModels(P("ollama"), { apiBase: "http://localhost:11434", fetchImpl });
    expect(r.source).toBe("live");
    expect(r.recommended).toBe("ollama/qwen2.5:7b"); // most recently modified
    expect(r.models).toContain("ollama/llama3.1"); // :latest stripped
    expect(r.models.some((m) => m.includes("embed"))).toBe(false);
  });
});

describe("listProviderModels — edge providers", () => {
  it("custom: never fetches, just hands back the freeform fallback", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    const r = await listProviderModels(P("custom"), { apiKey: "x", fetchImpl });
    expect(called).toBe(false);
    expect(r.source).toBe("fallback");
  });

  it("openai-compatible: needs a base URL; lists from {base}/v1/models when given", async () => {
    const noBase = await listProviderModels(P("openai-compatible"), { apiKey: "x", fetchImpl: jsonFetch({ data: [] }) });
    expect(noBase.source).toBe("fallback");

    const withBase = await listProviderModels(P("openai-compatible"), {
      apiKey: "x",
      apiBase: "http://localhost:1234/v1",
      fetchImpl: jsonFetch({ data: [{ id: "local-llama", created: 1 }] }),
    });
    expect(withBase.source).toBe("live");
    expect(withBase.models).toContain("openai/local-llama");
  });
});

describe("key validation — auth vs network classification", () => {
  it("a rejected key is flagged auth (HTTP 401) so the caller re-asks, never proceeds", async () => {
    const r = await listProviderModels(P("openai"), {
      apiKey: "bad",
      fetchImpl: jsonFetch({ error: { message: "Incorrect API key provided" } }, 401),
    });
    expect(r.source).toBe("fallback");
    expect(r.reason).toBe("auth");
  });

  it("Gemini's 400 'API key not valid' is caught as auth via the response body", async () => {
    const r = await listProviderModels(P("gemini"), {
      apiKey: "bad",
      fetchImpl: jsonFetch({ error: { message: "API key not valid. Please pass a valid API key." } }, 400),
    });
    expect(r.reason).toBe("auth");
  });

  it("a transient 5xx / network error is 'network' (key unverified, caller may proceed)", async () => {
    const r500 = await listProviderModels(P("openai"), { apiKey: "sk-x", fetchImpl: jsonFetch({}, 500) });
    expect(r500.reason).toBe("network");
    const rThrow = await listProviderModels(P("openai"), { apiKey: "sk-x", fetchImpl: throwingFetch("ETIMEDOUT") });
    expect(rThrow.reason).toBe("network");
  });
});

describe("rankCandidates", () => {
  it("orders by preferred family, then recency, then version", () => {
    const ranked = rankCandidates("openai", [
      { id: "gpt-4o", ts: 100, chat: true },
      { id: "gpt-4o-mini", ts: 50, chat: true },
      { id: "some-embedding", ts: 999, chat: false },
    ]);
    expect(ranked).toEqual(["gpt-4o-mini", "gpt-4o"]); // mini preferred despite older ts; non-chat dropped
  });
});

describe("resolveModelAnswer", () => {
  const shown = ["gpt-4o-mini", "gpt-4o", "o3-mini"];
  it("empty → recommended", () => {
    expect(resolveModelAnswer("", shown, "gpt-4o-mini")).toBe("gpt-4o-mini");
  });
  it("in-range number → that entry", () => {
    expect(resolveModelAnswer("2", shown, "gpt-4o-mini")).toBe("gpt-4o");
  });
  it("a typed id passes through (new models work the day they ship)", () => {
    expect(resolveModelAnswer("anthropic/claude-3-5-haiku-latest", shown, "gpt-4o-mini")).toBe(
      "anthropic/claude-3-5-haiku-latest",
    );
  });
});
