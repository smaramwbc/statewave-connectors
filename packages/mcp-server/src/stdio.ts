import { ConnectorError } from "@statewavedev/connectors-core";
import { StatewaveClient, type StatewaveClientOptions } from "./client.js";
import { dispatchTool } from "./dispatcher.js";
import { STATEWAVE_MCP_TOOLS } from "./tools-registry.js";

/**
 * Minimal MCP stdio transport (JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout).
 *
 * This implements just enough of the Model Context Protocol for an MCP-compatible
 * client to discover Statewave tools and invoke them. We deliberately keep it
 * dependency-free and small (~80 lines): the wire format is stable and a third-party
 * SDK isn't worth the dep weight at v0.1.0.
 *
 * Methods implemented:
 *   - initialize        → returns server info + capabilities
 *   - tools/list        → returns STATEWAVE_MCP_TOOLS
 *   - tools/call        → dispatches to dispatchTool() against StatewaveClient
 *   - ping              → `{}`
 *   - notifications/initialized → no-op (notifications carry no id)
 *   - shutdown          → resolves the run promise so the server can exit cleanly
 *
 * Anything else returns a JSON-RPC -32601 method-not-found error.
 */

export interface McpStdioOptions {
  client: StatewaveClient;
  /** Override stdin (used by tests). */
  stdin?: NodeJS.ReadableStream;
  /** Override stdout (used by tests). */
  stdout?: NodeJS.WritableStream;
  /** Override stderr (used by tests). */
  stderr?: NodeJS.WritableStream;
  /** Server name reported in `initialize` (overridable for forks). */
  serverName?: string;
  /** Server version reported in `initialize`. */
  serverVersion?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

const PROTOCOL_VERSION = "2024-11-05";

/**
 * Run the stdio transport until stdin closes (or `shutdown` arrives).
 * Resolves on clean shutdown; rejects only on fatal write errors.
 */
export async function runStdioServer(options: McpStdioOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const name = options.serverName ?? "statewave-mcp-server";
  const version = options.serverVersion ?? "0.1.0";

  let buffer = "";
  let shuttingDown = false;

  const writeFrame = (payload: unknown): void => {
    stdout.write(JSON.stringify(payload) + "\n");
  };

  const handleRequest = async (req: JsonRpcRequest): Promise<void> => {
    if (req.method === "notifications/initialized") return;
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case "initialize": {
          writeFrame({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name, version },
            },
          });
          return;
        }
        case "tools/list": {
          writeFrame({
            jsonrpc: "2.0",
            id,
            result: {
              tools: STATEWAVE_MCP_TOOLS.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            },
          });
          return;
        }
        case "tools/call": {
          const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
          if (typeof params.name !== "string") throw paramsError("tools/call requires { name, arguments }");
          const { result } = await dispatchTool(options.client, params.name, params.arguments ?? {});
          writeFrame({
            jsonrpc: "2.0",
            id,
            result: {
              // MCP tool calls return a content array; we wrap the JSON result as a single
              // text part so any compliant client can render it. Future revisions may
              // expand this to typed parts (e.g. resource references for retrieved memories).
              content: [{ type: "text", text: JSON.stringify(result) }],
              isError: false,
            },
          });
          return;
        }
        case "ping": {
          writeFrame({ jsonrpc: "2.0", id, result: {} });
          return;
        }
        case "shutdown": {
          shuttingDown = true;
          writeFrame({ jsonrpc: "2.0", id, result: null });
          return;
        }
        default:
          writeFrame({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `method not found: ${req.method}` },
          });
      }
    } catch (err) {
      const ce = err as ConnectorError | Error;
      writeFrame({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: ce.message ?? "internal error",
          data: ce instanceof ConnectorError ? ce.toJSON() : undefined,
        },
      });
      stderr.write(`mcp-server error: ${ce.message ?? String(err)}\n`);
    }
  };

  // Serialize request handling: each new request waits for the previous to
  // finish before its response is written. This keeps frame ordering on stdout
  // matching the order requests arrived on stdin (clients rely on it) and
  // ensures `shutdown` is acted on only after preceding tool calls drain.
  let chain: Promise<void> = Promise.resolve();

  return new Promise((resolve, reject) => {
    const checkShutdown = (): void => {
      if (shuttingDown) {
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        resolve();
      }
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          let parsed: JsonRpcRequest | undefined;
          try {
            parsed = JSON.parse(line) as JsonRpcRequest;
          } catch {
            writeFrame({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "parse error" },
            });
          }
          if (parsed) {
            const req = parsed;
            chain = chain.then(() => handleRequest(req)).then(checkShutdown);
          }
        }
        nl = buffer.indexOf("\n");
      }
    };
    const onEnd = (): void => {
      chain.then(() => resolve());
    };
    const onError = (err: Error): void => reject(err);
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    stdout.on("error", onError);
  });
}

function paramsError(message: string): ConnectorError {
  return new ConnectorError(message, { code: "config_invalid" });
}

/** Construct the StatewaveClient from environment + options and run stdio. */
export async function startStdioServerFromEnv(options?: Partial<StatewaveClientOptions>): Promise<void> {
  const url = options?.url ?? process.env.STATEWAVE_URL;
  if (!url) {
    throw new ConnectorError("STATEWAVE_URL is required to start the MCP stdio server", {
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
  await runStdioServer({ client });
}
