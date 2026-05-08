import { describe, it, expect, vi } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
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
        return new Response(JSON.stringify({ memories: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });
    await client.searchMemories({ query: "x", subject: "repo:a/b" });
    expect(seen.headers?.get("x-api-key")).toBe("k1");
    expect(seen.headers?.get("x-tenant-id")).toBe("t1");
  });

  it("maps 401 to auth_failed", async () => {
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: fakeFetch(() => new Response("nope", { status: 401 })),
    });
    await expect(client.getContext({ subject: "x", query: "what" })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "auth_failed",
    });
  });

  it("maps 429 to rate_limited", async () => {
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: fakeFetch(() => new Response("slow down", { status: 429 })),
    });
    await expect(client.getContext({ subject: "x", query: "what" })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "rate_limited",
    });
  });

  it("ingestEpisode translates connectors-core shape to the server's CreateEpisodeRequest wire format", async () => {
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
        return new Response(JSON.stringify({ id: "ep-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });
    const result = await client.ingestEpisode({
      subject: "repo:a/b",
      kind: "github.issue.opened",
      text: "x",
      occurred_at: "2026-01-01T00:00:00.000Z",
      source: { type: "github.issue", id: "a/b#1", url: "https://github.com/a/b/issues/1" },
      idempotency_key: "k",
    });
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/v1/episodes");
    const wire = JSON.parse(seen.body!);
    // The server speaks subject_id / type / source(string) / payload(dict).
    expect(wire.subject_id).toBe("repo:a/b");
    expect(wire.type).toBe("github.issue.opened");
    expect(wire.source).toBe("github.issue");
    expect(wire.payload.text).toBe("x");
    expect(wire.payload.source_id).toBe("a/b#1");
    expect(wire.payload.source_url).toBe("https://github.com/a/b/issues/1");
    expect(wire.metadata.idempotency_key).toBe("k");
    // The connectors-core IngestResponse stays stable so callers don't break.
    expect(result.idempotency_key).toBe("k");
    expect(result.id).toBe("ep-1");
  });

  it("searchMemories translates subject → subject_id and query → q, then maps content → text", async () => {
    const seen: { path?: string } = {};
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: fakeFetch((url) => {
        seen.path = (typeof url === "string" ? url : (url as URL).toString()).replace(
          /^http:\/\/localhost:8000/,
          "",
        );
        return new Response(
          JSON.stringify({
            memories: [
              { id: "m1", subject_id: "repo:a/b", kind: "fact", content: "hello", summary: "h" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });
    const result = await client.searchMemories({ query: "test", subject: "repo:a/b", limit: 5 });
    expect(seen.path).toContain("/v1/memories/search?");
    expect(seen.path).toContain("subject_id=repo%3Aa%2Fb");
    expect(seen.path).toContain("q=test");
    expect(seen.path).toContain("limit=5");
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("hello");
    expect(result[0]!.subject).toBe("repo:a/b");
  });

  it("getContext translates query → task and merges facts + procedures into memories", async () => {
    const seen: { body?: string } = {};
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: fakeFetch((_url, init) => {
        seen.body = init?.body as string;
        return new Response(
          JSON.stringify({
            subject_id: "repo:a/b",
            assembled_context: "stuff",
            facts: [{ id: "f1", subject_id: "repo:a/b", kind: "fact", content: "F1" }],
            procedures: [{ id: "p1", subject_id: "repo:a/b", kind: "proc", content: "P1" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });
    const result = await client.getContext({ subject: "repo:a/b", query: "what is X" });
    const wire = JSON.parse(seen.body!);
    expect(wire.subject_id).toBe("repo:a/b");
    expect(wire.task).toBe("what is X");
    expect(result.subject).toBe("repo:a/b");
    expect(result.assembled_context).toBe("stuff");
    expect(result.memories).toHaveLength(2);
  });

  it("compileSubject translates subject → subject_id and posts async:false", async () => {
    const seen: { body?: string } = {};
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: fakeFetch((_url, init) => {
        seen.body = init?.body as string;
        return new Response(JSON.stringify({ subject_id: "repo:a/b", status: "succeeded" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });
    const result = await client.compileSubject({ subject: "repo:a/b" });
    const wire = JSON.parse(seen.body!);
    expect(wire.subject_id).toBe("repo:a/b");
    expect(wire.async).toBe(false);
    expect(result.subject).toBe("repo:a/b");
    expect(result.status).toBe("succeeded");
  });

  it("getTimeline maps episodes through payload.text, falling back to JSON dump", async () => {
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: fakeFetch(() =>
        new Response(
          JSON.stringify({
            subject_id: "repo:a/b",
            episodes: [
              { id: "e1", subject_id: "repo:a/b", type: "github.issue.opened", payload: { text: "hi" }, occurred_at: "2026-01-01T00:00:00Z" },
              { id: "e2", subject_id: "repo:a/b", type: "github.pr.opened", payload: { title: "x" }, occurred_at: "2026-01-02T00:00:00Z" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    });
    const result = await client.getTimeline({ subject: "repo:a/b" });
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toBe("hi");
    expect(result[1]!.text).toContain("title");
  });

  it("translates fetch errors into a retryable network error", async () => {
    const client = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    await expect(client.getContext({ subject: "x", query: "what" })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "network",
      retryable: true,
    });
  });
});
