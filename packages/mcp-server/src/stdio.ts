import { ConnectorError } from "@statewavedev/connectors-core";
import { StatewaveClient, type StatewaveClientOptions } from "./client.js";
import { handleJsonRpcMessage, type JsonRpcRequest } from "./protocol.js";

/**
 * Minimal MCP stdio transport (JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout).
 *
 * The protocol logic (initialize / tools/list / tools/call / ping / shutdown)
 * lives in `./protocol`, shared with the HTTP transport. This file is just the
 * stdio framing: read newline-delimited frames off stdin, hand each to the
 * shared handler, write the response back to stdout, and exit cleanly on
 * `shutdown` or stdin close.
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

/**
 * Run the stdio transport until stdin closes (or `shutdown` arrives).
 * Resolves on clean shutdown; rejects only on fatal write errors.
 */
export async function runStdioServer(options: McpStdioOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const handlerOptions = { serverName: options.serverName, serverVersion: options.serverVersion };

  let buffer = "";
  let shuttingDown = false;

  const writeFrame = (payload: unknown): void => {
    stdout.write(JSON.stringify(payload) + "\n");
  };

  const handleRequest = async (req: JsonRpcRequest): Promise<void> => {
    if (req.method === "shutdown") shuttingDown = true;
    const res = await handleJsonRpcMessage(options.client, req, handlerOptions);
    if (!res) return; // notification — no reply
    writeFrame(res);
    if (res.error) stderr.write(`mcp-server error: ${res.error.message}\n`);
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
