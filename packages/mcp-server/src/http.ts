import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ConnectorError } from "@statewavedev/connectors-core";
import { StatewaveClient, type StatewaveClientOptions } from "./client.js";
import { handleJsonRpcMessage, type JsonRpcRequest, type JsonRpcResponse } from "./protocol.js";

/**
 * MCP Streamable-HTTP transport.
 *
 * A single JSON-RPC endpoint (default `POST /mcp`) that remote MCP clients —
 * Claude.ai custom connectors, ChatGPT, hosted agents, a team pointing many
 * agents at one shared memory — can call over HTTP. The stdio transport is one
 * process on one machine; this is the same tool surface reachable from anywhere.
 *
 * Design choices:
 *   - **Stateless.** Each POST is handled on its own; we issue no session id
 *     (the spec makes sessions optional). Simpler to run and to scale behind a
 *     load balancer.
 *   - **No SSE stream.** Our tools are request/response with no server-initiated
 *     messages, so `GET <path>` returns 405. POST returns a single JSON reply.
 *   - **Safe by default.** Binds to 127.0.0.1, validates the `Origin` header to
 *     block DNS-rebinding from browsers, and supports an optional bearer token.
 *     Go public (`--host 0.0.0.0`) only behind TLS + a token.
 */

export const DEFAULT_HTTP_PORT = 8200;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpHttpOptions {
  client: StatewaveClient;
  host?: string;
  port?: number;
  /** JSON-RPC endpoint path (default `/mcp`). */
  path?: string;
  /** When set, every request to the MCP path must send `Authorization: Bearer <token>`. */
  authToken?: string;
  /**
   * Browser origins permitted to call the server. When omitted, requests with
   * no `Origin` (server-to-server clients) are allowed and browser origins are
   * restricted to localhost — the DNS-rebinding guard for local servers.
   */
  allowedOrigins?: ReadonlyArray<string>;
  serverName?: string;
  serverVersion?: string;
}

function originAllowed(origin: string | undefined, allowed?: ReadonlyArray<string>): boolean {
  if (!origin) return true; // non-browser client (no Origin header)
  if (allowed && allowed.length > 0) return allowed.includes(origin);
  // Default policy: only localhost browser origins may call a local server.
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(payload);
}

function rpcError(id: JsonRpcResponse["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ConnectorError("request body too large", { code: "config_invalid" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers["authorization"];
  return header === `Bearer ${token}`;
}

/**
 * Build (but do not start) the HTTP server. Exposed for tests and embedding;
 * call `.listen()` yourself, or use `runHttpServer` for the daemon path.
 */
export function createMcpHttpServer(options: McpHttpOptions): Server {
  const path = options.path ?? DEFAULT_HTTP_PATH;
  const handlerOptions = { serverName: options.serverName, serverVersion: options.serverVersion };

  return createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // Last-resort guard — handle() catches its own errors, so reaching here
      // means the response was likely already sent; just avoid a crash.
      if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, (err as Error).message));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers["origin"] as string | undefined;
    const url = new URL(req.url ?? "/", "http://localhost");

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(originAllowed(origin, options.allowedOrigins) ? origin : undefined));
      res.end();
      return;
    }

    // Unauthenticated liveness probe for orchestrators / uptime checks.
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (url.pathname !== path) {
      sendJson(res, 404, rpcError(null, -32601, `not found: ${url.pathname}`));
      return;
    }

    if (!originAllowed(origin, options.allowedOrigins)) {
      sendJson(res, 403, rpcError(null, -32000, "origin not allowed"));
      return;
    }
    if (!authorized(req, options.authToken)) {
      sendJson(res, 401, rpcError(null, -32000, "unauthorized"), {
        "WWW-Authenticate": "Bearer",
      });
      return;
    }

    const cors = corsHeaders(origin);

    // We don't offer a server→client SSE stream (no server-initiated messages),
    // so GET on the endpoint is Method Not Allowed per the spec.
    if (req.method === "GET") {
      sendJson(res, 405, rpcError(null, -32000, "this endpoint accepts POST"), { Allow: "POST", ...cors });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, rpcError(null, -32000, "method not allowed"), { Allow: "POST, OPTIONS", ...cors });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, 413, rpcError(null, -32000, (err as Error).message), cors);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, rpcError(null, -32700, "parse error"), cors);
      return;
    }

    // Batch or single. Notifications (handler returns null) drop out; if the
    // whole request was notifications, reply 202 Accepted with no body.
    if (Array.isArray(parsed)) {
      const responses: JsonRpcResponse[] = [];
      for (const msg of parsed) {
        const r = await handleJsonRpcMessage(options.client, msg as JsonRpcRequest, handlerOptions);
        if (r) responses.push(r);
      }
      if (responses.length === 0) {
        res.writeHead(202, cors);
        res.end();
        return;
      }
      sendJson(res, 200, responses, cors);
      return;
    }

    const response = await handleJsonRpcMessage(options.client, parsed as JsonRpcRequest, handlerOptions);
    if (!response) {
      res.writeHead(202, cors);
      res.end();
      return;
    }
    sendJson(res, 200, response, cors);
  }
}

/**
 * Start the HTTP transport and resolve once it's listening. The returned handle
 * exposes the bound `url` and a `close()` for graceful shutdown.
 */
export async function runHttpServer(
  options: McpHttpOptions,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const host = options.host ?? DEFAULT_HTTP_HOST;
  const port = options.port ?? DEFAULT_HTTP_PORT;
  const path = options.path ?? DEFAULT_HTTP_PATH;
  const server = createMcpHttpServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${boundPort}${path}`;

  return {
    server,
    url,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Construct the client from env + options, start HTTP, and run until SIGINT/SIGTERM. */
export async function startHttpServerFromEnv(
  options?: Partial<StatewaveClientOptions> & {
    host?: string;
    port?: number;
    path?: string;
    authToken?: string;
    allowedOrigins?: ReadonlyArray<string>;
    log?: (message: string) => void;
  },
): Promise<void> {
  const url = options?.url ?? process.env.STATEWAVE_URL;
  if (!url) {
    throw new ConnectorError("STATEWAVE_URL is required to start the MCP HTTP server", {
      code: "config_invalid",
      hint: "set STATEWAVE_URL or pass options.url",
    });
  }
  const client = new StatewaveClient({
    url,
    apiKey: options?.apiKey ?? process.env.STATEWAVE_API_KEY,
    tenantId: options?.tenantId ?? process.env.STATEWAVE_TENANT_ID,
    fetchImpl: options?.fetchImpl,
  });

  const authToken = options?.authToken ?? process.env.STATEWAVE_MCP_AUTH_TOKEN;
  const handle = await runHttpServer({
    client,
    host: options?.host,
    port: options?.port,
    path: options?.path,
    authToken,
    allowedOrigins: options?.allowedOrigins,
  });

  const log = options?.log ?? ((m: string) => process.stderr.write(m + "\n"));
  log(`statewave mcp http listening on ${handle.url}${authToken ? " (bearer auth on)" : ""}`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void handle.close().then(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
