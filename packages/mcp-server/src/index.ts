import { ConnectorError } from "@statewavedev/connectors-core";
import { StatewaveClient } from "./client.js";
import { startHttpServerFromEnv } from "./http.js";
import { startStdioServerFromEnv } from "./stdio.js";
import { STATEWAVE_MCP_TOOLS } from "./tools-registry.js";
import type { McpServerOptions, McpToolDefinition } from "./types.js";

export { STATEWAVE_MCP_TOOLS } from "./tools-registry.js";

export type { McpServerOptions, McpToolDefinition } from "./types.js";
export { StatewaveClient } from "./client.js";
export type {
  ContextBundle,
  IngestResponse,
  MemorySearchResult,
  StatewaveClientOptions,
  TimelineItem,
  CompileSummary,
} from "./client.js";
export { dispatchTool } from "./dispatcher.js";
export type { DispatchResult } from "./dispatcher.js";
export { runStdioServer, startStdioServerFromEnv } from "./stdio.js";
export type { McpStdioOptions } from "./stdio.js";
export {
  createMcpHttpServer,
  runHttpServer,
  startHttpServerFromEnv,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTP_PATH,
} from "./http.js";
export type { McpHttpOptions } from "./http.js";
export {
  handleJsonRpcMessage,
  isNotification,
  PROTOCOL_VERSION,
} from "./protocol.js";
export type { JsonRpcRequest, JsonRpcResponse, HandlerOptions } from "./protocol.js";

export function listTools(): ReadonlyArray<McpToolDefinition> {
  return STATEWAVE_MCP_TOOLS;
}

export interface StartOptions extends McpServerOptions {
  /** When true, print tool definitions and exit without starting any transport. */
  listToolsOnly?: boolean;
  /** Output stream override for `listToolsOnly` mode. */
  stdout?: NodeJS.WritableStream;
  /** Transport to run. Defaults to `stdio` (one process, one client). */
  transport?: "stdio" | "http";
  /** HTTP transport settings (used when `transport: "http"`). */
  http?: {
    host?: string;
    port?: number;
    path?: string;
    authToken?: string;
    allowedOrigins?: ReadonlyArray<string>;
  };
}

/**
 * v0.1.0 MCP server entry point.
 *
 * - With `listToolsOnly: true`, prints the canonical tool surface and exits.
 *   Useful for clients that consume schemas before connecting.
 * - Otherwise, starts the minimal stdio JSON-RPC 2.0 transport from
 *   `./stdio` against a `StatewaveClient` constructed from env vars.
 *
 * Programmatic users who already have an MCP runtime can import
 * `dispatchTool` + `StatewaveClient` directly and skip this function.
 */
export async function startMcpServer(options: StartOptions = {}): Promise<void> {
  // List-tools mode is pure schema discovery — it never contacts Statewave, so
  // it must not require STATEWAVE_URL. The URL is enforced only on the path
  // that actually starts the transport.
  if (options.listToolsOnly) {
    const stream = options.stdout ?? process.stdout;
    const url = options.statewaveUrl ?? process.env.STATEWAVE_URL ?? null;
    stream.write(
      JSON.stringify(
        {
          server: "statewave-mcp-server",
          statewave_url: url,
          tools: STATEWAVE_MCP_TOOLS,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const url = options.statewaveUrl ?? process.env.STATEWAVE_URL;
  if (!url) {
    throw new ConnectorError("STATEWAVE_URL is required to start the MCP server", {
      code: "config_invalid",
      hint: "set STATEWAVE_URL in the environment or pass options.statewaveUrl",
    });
  }

  // Touch the import to keep TS happy when the function is exported but not used.
  void StatewaveClient;

  if (options.transport === "http") {
    await startHttpServerFromEnv({
      url,
      apiKey: options.apiKey,
      tenantId: options.tenantId,
      host: options.http?.host,
      port: options.http?.port,
      path: options.http?.path,
      authToken: options.http?.authToken,
      allowedOrigins: options.http?.allowedOrigins,
    });
    return;
  }

  await startStdioServerFromEnv({
    url,
    apiKey: options.apiKey,
    tenantId: options.tenantId,
  });
}
