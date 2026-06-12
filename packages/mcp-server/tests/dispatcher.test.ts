import { describe, it, expect, vi } from "vitest";
import { dispatchTool, StatewaveClient } from "../src/index.js";

function client(handler: () => Response): StatewaveClient {
  return new StatewaveClient({
    url: "http://localhost:8000",
    fetchImpl: (async () => handler()) as typeof fetch,
  });
}

describe("dispatchTool", () => {
  it("rejects unknown tools", async () => {
    const c = client(() => new Response("{}"));
    await expect(dispatchTool(c, "nope", {})).rejects.toMatchObject({
      name: "ConnectorError",
      code: "unsupported",
    });
  });

  it("validates ingest_episode payload before calling Statewave", async () => {
    const fetchSpy = vi.fn(() => new Response("{}"));
    const c = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: (async () => fetchSpy()) as typeof fetch,
    });
    await expect(
      dispatchTool(c, "statewave_ingest_episode", { subject: "x" }),
    ).rejects.toMatchObject({ name: "ConnectorError", code: "config_invalid" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects search_memories without subject", async () => {
    const fetchSpy = vi.fn(() => new Response("{}"));
    const c = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: (async () => fetchSpy()) as typeof fetch,
    });
    await expect(
      dispatchTool(c, "statewave_search_memories", { query: "ci" }),
    ).rejects.toMatchObject({ name: "ConnectorError", code: "config_invalid" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects get_context without query", async () => {
    const fetchSpy = vi.fn(() => new Response("{}"));
    const c = new StatewaveClient({
      url: "http://localhost:8000",
      fetchImpl: (async () => fetchSpy()) as typeof fetch,
    });
    await expect(
      dispatchTool(c, "statewave_get_context", { subject: "repo:a/b" }),
    ).rejects.toMatchObject({ name: "ConnectorError", code: "config_invalid" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatches search_memories", async () => {
    const c = client(
      () =>
        new Response(
          JSON.stringify({
            // Server returns SearchMemoriesResponse {memories: [...]}; the
            // client unwraps + maps content → text for the connectors-core
            // MemorySearchResult shape.
            memories: [{ id: "m1", subject_id: "repo:a/b", kind: "fact", content: "hi" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const r = await dispatchTool(c, "statewave_search_memories", { query: "ci", subject: "repo:a/b" });
    expect(r.tool).toBe("statewave_search_memories");
    expect((r.result as Array<{ id: string }>)[0]?.id).toBe("m1");
  });

  it("dispatches compile_subject with the configured subject", async () => {
    const c = client(
      () =>
        new Response(JSON.stringify({ subject_id: "repo:a/b", status: "started" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const r = await dispatchTool(c, "statewave_compile_subject", { subject: "repo:a/b" });
    expect((r.result as { status: string }).status).toBe("started");
  });

  it("dispatches list_subjects (no subject required) for subject discovery", async () => {
    const c = client(
      () =>
        new Response(
          JSON.stringify({ subjects: [{ subject_id: "repo:acme.demo", episode_count: 3, memory_count: 1 }], total: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const r = await dispatchTool(c, "statewave_list_subjects", {});
    expect(r.tool).toBe("statewave_list_subjects");
    expect((r.result as { subjects: Array<{ subject_id: string }> }).subjects[0]?.subject_id).toBe("repo:acme.demo");
  });
});
