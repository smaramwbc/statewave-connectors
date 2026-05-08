import { describe, it, expect } from "vitest";
import { Readable, PassThrough } from "node:stream";
import { runStdioServer, StatewaveClient } from "../src/index.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function makeClient(handler: (path: string, body?: string) => unknown): StatewaveClient {
  return new StatewaveClient({
    url: "http://localhost:8000",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const path = url.replace("http://localhost:8000", "");
      const body = typeof init?.body === "string" ? init.body : undefined;
      return new Response(JSON.stringify(handler(path, body)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
}

async function runWith(
  frames: ReadonlyArray<unknown>,
  client: StatewaveClient,
): Promise<JsonRpcResponse[]> {
  const stdinPayload = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
  const stdin = Readable.from([Buffer.from(stdinPayload, "utf8")]);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const collected: Buffer[] = [];
  stdout.on("data", (b: Buffer) => collected.push(b));

  await runStdioServer({ client, stdin, stdout, stderr });

  return Buffer.concat(collected)
    .toString("utf8")
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s) as JsonRpcResponse);
}

describe("MCP stdio transport", () => {
  it("answers initialize → tools/list → ping → shutdown", async () => {
    const client = makeClient(() => ({}));
    const out = await runWith(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "ping" },
        { jsonrpc: "2.0", id: 4, method: "shutdown" },
      ],
      client,
    );

    expect(out).toHaveLength(4);
    const init = out[0]!.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(init.serverInfo.name).toBe("statewave-mcp-server");
    expect(init.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const list = out[1]!.result as { tools: Array<{ name: string }> };
    const toolNames = list.tools.map((t) => t.name).sort();
    expect(toolNames).toContain("statewave_get_context");
    expect(toolNames).toContain("statewave_ingest_episode");

    expect(out[2]!.result).toEqual({});
    expect(out[3]!.result).toBeNull();
  });

  it("dispatches tools/call to the StatewaveClient", async () => {
    let lastPath: string | undefined;
    let lastBody: string | undefined;
    const client = makeClient((path, body) => {
      lastPath = path;
      lastBody = body;
      // Server response shape — the StatewaveClient flattens this back into
      // the connectors-core ContextBundle for the JSON-RPC reply.
      return {
        subject_id: "repo:a/b",
        task: "what is a/b",
        assembled_context: "facts about a/b",
        token_estimate: 42,
        facts: [],
        procedures: [],
      };
    });

    const out = await runWith(
      [
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "statewave_get_context",
            arguments: { subject: "repo:a/b", query: "what is a/b" },
          },
        },
        { jsonrpc: "2.0", id: 8, method: "shutdown" },
      ],
      client,
    );

    expect(lastPath).toBe("/v1/context");
    // The wire body uses subject_id + task — the client translates the
    // connectors-core idiom (subject + query) into the server's CreateContextRequest.
    const wire = JSON.parse(lastBody!);
    expect(wire.subject_id).toBe("repo:a/b");
    expect(wire.task).toBe("what is a/b");
    const result = out[0]!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ subject: "repo:a/b" });
  });

  it("returns -32601 for unknown methods", async () => {
    const client = makeClient(() => ({}));
    const out = await runWith(
      [
        { jsonrpc: "2.0", id: 1, method: "frobnicate" },
        { jsonrpc: "2.0", id: 2, method: "shutdown" },
      ],
      client,
    );
    expect(out[0]!.error?.code).toBe(-32601);
  });

  it("returns a tools/call error when the dispatcher rejects bad input", async () => {
    const client = makeClient(() => ({}));
    const out = await runWith(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "statewave_ingest_episode", arguments: { subject: "x" } },
        },
        { jsonrpc: "2.0", id: 2, method: "shutdown" },
      ],
      client,
    );
    expect(out[0]!.error?.code).toBe(-32000);
    expect(out[0]!.error?.message).toMatch(/missing required string field/);
  });
});
