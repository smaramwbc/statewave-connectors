import { ConnectorError } from "@statewavedev/connectors-core";
import type { StatewaveClient } from "./client.js";
import { dispatchTool } from "./dispatcher.js";
import { STATEWAVE_MCP_TOOLS } from "./tools-registry.js";

/**
 * Transport-agnostic MCP JSON-RPC handling.
 *
 * Both transports (stdio, HTTP) translate their wire frames into a
 * `JsonRpcRequest`, call `handleJsonRpcMessage`, and serialize the returned
 * `JsonRpcResponse` back onto the wire. Keeping the method dispatch here means
 * the two transports can never drift on what `initialize` / `tools/list` /
 * `tools/call` actually do.
 */

export const PROTOCOL_VERSION = "2024-11-05";
export const DEFAULT_SERVER_NAME = "statewave-mcp-server";
export const DEFAULT_SERVER_VERSION = "0.1.0";

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface HandlerOptions {
  serverName?: string;
  serverVersion?: string;
}

/**
 * JSON-RPC notifications carry no `id` and expect no reply. MCP namespaces them
 * under `notifications/*` (e.g. `notifications/initialized`). Either signal —
 * the `notifications/` prefix or a missing id — marks a fire-and-forget message.
 */
export function isNotification(req: JsonRpcRequest): boolean {
  return req.method.startsWith("notifications/") || req.id === undefined;
}

/**
 * Handle one JSON-RPC message. Returns the response to send, or `null` for
 * notifications (which get no reply). Never throws: tool/dispatch failures come
 * back as JSON-RPC error responses so the caller only has to serialize.
 */
export async function handleJsonRpcMessage(
  client: StatewaveClient,
  req: JsonRpcRequest,
  options: HandlerOptions = {},
): Promise<JsonRpcResponse | null> {
  if (isNotification(req)) return null;

  const id = req.id ?? null;
  const name = options.serverName ?? DEFAULT_SERVER_NAME;
  const version = options.serverVersion ?? DEFAULT_SERVER_VERSION;

  try {
    switch (req.method) {
      case "initialize": {
        // Echo the client's requested protocol version when it sends one, so
        // newer clients (which negotiate a later revision for the HTTP
        // transport) get a version they accept; fall back to our baseline.
        const params = (req.params ?? {}) as { protocolVersion?: unknown };
        const protocolVersion =
          typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name, version },
          },
        };
      }
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: STATEWAVE_MCP_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };
      case "tools/call": {
        const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
        if (typeof params.name !== "string") {
          throw new ConnectorError("tools/call requires { name, arguments }", {
            code: "config_invalid",
          });
        }
        const { result } = await dispatchTool(client, params.name, params.arguments ?? {});
        return {
          jsonrpc: "2.0",
          id,
          result: {
            // MCP tool calls return a content array; we wrap the JSON result as a
            // single text part so any compliant client can render it.
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: false,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "shutdown":
        return { jsonrpc: "2.0", id, result: null };
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `method not found: ${req.method}` },
        };
    }
  } catch (err) {
    const ce = err as ConnectorError | Error;
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: ce.message ?? "internal error",
        data: ce instanceof ConnectorError ? ce.toJSON() : undefined,
      },
    };
  }
}
