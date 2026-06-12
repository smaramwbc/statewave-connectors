import { describe, it, expect } from "vitest";
import { buildProviderEnv, findProvider, providerLacksEmbeddings, PROVIDERS } from "../src/commands/providers.js";

describe("provider registry", () => {
  it("is not OpenAI-only", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["openai", "anthropic", "gemini", "ollama", "openai-compatible", "custom"]),
    );
  });
});

describe("buildProviderEnv", () => {
  it("OpenAI: model + key + litellm embeddings", () => {
    const env = buildProviderEnv({ provider: "openai", apiKey: "sk-x" });
    expect(env).toMatchObject({
      STATEWAVE_COMPILER_TYPE: "llm",
      STATEWAVE_LITELLM_MODEL: "gpt-4o-mini",
      STATEWAVE_LITELLM_API_KEY: "sk-x",
      STATEWAVE_EMBEDDING_PROVIDER: "litellm",
      STATEWAVE_LITELLM_EMBEDDING_MODEL: "text-embedding-3-small",
    });
    expect(env.STATEWAVE_LITELLM_API_BASE).toBeUndefined();
  });

  it("Anthropic: LLM compiler but keyword retrieval (no embeddings)", () => {
    const env = buildProviderEnv({ provider: "anthropic", apiKey: "sk-ant" });
    expect(env.STATEWAVE_LITELLM_MODEL).toBe("anthropic/claude-3-5-haiku-latest");
    expect(env.STATEWAVE_COMPILER_TYPE).toBe("llm");
    expect(env.STATEWAVE_EMBEDDING_PROVIDER).toBe("stub");
    expect(env.STATEWAVE_LITELLM_EMBEDDING_MODEL).toBeUndefined();
    expect(providerLacksEmbeddings("anthropic")).toBe(true);
  });

  it("Anthropic with an explicit embedding model uses litellm embeddings", () => {
    const env = buildProviderEnv({
      provider: "anthropic",
      apiKey: "sk-ant",
      embeddingModel: "text-embedding-3-small",
    });
    expect(env.STATEWAVE_EMBEDDING_PROVIDER).toBe("litellm");
    expect(env.STATEWAVE_LITELLM_EMBEDDING_MODEL).toBe("text-embedding-3-small");
  });

  it("Ollama: api_base default, no key", () => {
    const env = buildProviderEnv({ provider: "ollama" });
    expect(env.STATEWAVE_LITELLM_MODEL).toBe("ollama/llama3.1");
    expect(env.STATEWAVE_LITELLM_API_BASE).toBe("http://localhost:11434");
    expect(env.STATEWAVE_LITELLM_EMBEDDING_MODEL).toBe("ollama/nomic-embed-text");
    expect(env.STATEWAVE_LITELLM_API_KEY).toBeUndefined();
  });

  it("OpenAI-compatible: honors custom model + api base", () => {
    const env = buildProviderEnv({
      provider: "openai-compatible",
      model: "openai/llama-3.1-70b",
      apiKey: "sk-x",
      apiBase: "https://my-gateway.example/v1",
    });
    expect(env.STATEWAVE_LITELLM_MODEL).toBe("openai/llama-3.1-70b");
    expect(env.STATEWAVE_LITELLM_API_BASE).toBe("https://my-gateway.example/v1");
  });

  it("custom model id passes through and defaults to keyword retrieval", () => {
    const env = buildProviderEnv({ provider: "custom", model: "groq/llama-3.1-8b-instant", apiKey: "gsk" });
    expect(env.STATEWAVE_LITELLM_MODEL).toBe("groq/llama-3.1-8b-instant");
    expect(env.STATEWAVE_EMBEDDING_PROVIDER).toBe("stub");
  });

  it("findProvider returns undefined for unknown ids", () => {
    expect(findProvider("nope")).toBeUndefined();
  });
});
