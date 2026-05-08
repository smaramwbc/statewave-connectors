import { describe, it, expect, vi } from "vitest";
import { ConnectorError } from "@statewave/connectors-core";
import { StatewaveClient } from "../src/index.js";

function fakeFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(input, init)) as typeof fetch;
}

describe("StatewaveClient", () => {
  it("requires a url", () => {
    expect(() => new StatewaveClient({ url: "", fetchImpl: fetch })).toThrow(ConnectorError);
  });

  it("sends X-API-Key and X-Tenant-ID when configured", async () => {
    const seen: { headers?: Headers } = {};
    const client = new StatewaveClient({
      url: "http://localhost:8000/",
      apiKey: "k1",
      tenantId: "t1",
      fetchImpl: fakeFetch((_url, init) => {
        seen.headers = new Headers(init?.headers);
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }),
    });
    await client.searchMemories({ query: "x" });
    expect(seen.headers?.get("x-api-key")).toBe("k1");
    expect(seen.headers?.get("x-tenant-id")).toBe("t1");
  });

  it("maps 401 to auth_failed", async () => {
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: fakeFetch(() => new Response("nope", { status: 401 })),
    });
    await expect(client.getContext({ subject: "x" })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "auth_failed",
    });
  });

  it("maps 429 to rate_limited", async () => {
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: fakeFetch(() => new Response("slow down", { status: 429 })),
    });
    await expect(client.getContext({ subject: "x" })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "rate_limited",
    });
  });

  it("ingestEpisode posts to /v1/episodes with the episode body", async () => {
    const seen: { body?: string; method?: string; path?: string } = {};
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: fakeFetch((url, init) => {
        seen.method = init?.method;
        seen.path = (typeof url === "string" ? url : (url as URL).toString()).replace(
          /^http:\/\/localhost:8000/,
          "",
        );
        seen.body = init?.body as string;
        return new Response(JSON.stringify({ idempotency_key: "k" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });
    await client.ingestEpisode({
      subject: "repo:a/b",
      kind: "github.issue.opened",
      text: "x",
      occurred_at: "2026-01-01T00:00:00.000Z",
      source: { type: "github.issue", id: "a/b#1" },
      idempotency_key: "k",
    });
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/v1/episodes");
    expect(JSON.parse(seen.body!).subject).toBe("repo:a/b");
  });

  it("translates fetch errors into a retryable network error", async () => {
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    await expect(client.getContext({ subject: "x" })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "network",
      retryable: true,
    });
  });
});
