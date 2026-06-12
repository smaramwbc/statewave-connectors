import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMcpHttpServer, StatewaveClient } from "../src/index.js";

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

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

async function start(opts: Parameters<typeof createMcpHttpServer>[0]): Promise<string> {
  const server = createMcpHttpServer(opts);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function rpc(method: string, params?: unknown, id: number | string = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

describe("MCP HTTP transport", () => {
  it("answers initialize and echoes the client's protocol version", async () => {
    const base = await start({ client: makeClient(() => ({})) });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpc("initialize", { protocolVersion: "2025-06-18" })),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("statewave-mcp-server");
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("lists tools", async () => {
    const base = await start({ client: makeClient(() => ({})) });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpc("tools/list")),
    });
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("statewave_get_context");
  });

  it("dispatches tools/call to the StatewaveClient", async () => {
    let path: string | undefined;
    const base = await start({
      client: makeClient((p) => {
        path = p;
        return { subject_id: "repo:x", assembled_context: "ctx", facts: [], procedures: [] };
      }),
    });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        rpc("tools/call", { name: "statewave_get_context", arguments: { subject: "repo:x", query: "q" } }),
      ),
    });
    const body = await res.json();
    expect(path).toBe("/v1/context");
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ subject: "repo:x" });
  });

  it("returns 202 with no body for notifications", async () => {
    const base = await start({ client: makeClient(() => ({})) });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("answers the health probe and 405s GET on the endpoint", async () => {
    const base = await start({ client: makeClient(() => ({})) });
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    const get = await fetch(`${base}/mcp`);
    expect(get.status).toBe(405);
  });

  it("returns -32700 on a malformed body", async () => {
    const base = await start({ client: makeClient(() => ({})) });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("enforces a bearer token when configured", async () => {
    const base = await start({ client: makeClient(() => ({})), authToken: "s3cret" });
    const unauth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpc("ping")),
    });
    expect(unauth.status).toBe(401);
    const ok = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
      body: JSON.stringify(rpc("ping")),
    });
    expect(ok.status).toBe(200);
  });

  it("rejects a disallowed browser Origin", async () => {
    const base = await start({
      client: makeClient(() => ({})),
      allowedOrigins: ["https://app.statewave.ai"],
    });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify(rpc("ping")),
    });
    expect(res.status).toBe(403);
  });
});
