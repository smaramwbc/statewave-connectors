import type { ParsedArgs } from "../args.js";
import { flagAsBool } from "../args.js";
import { Output } from "../output.js";

export async function runMcp(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const [, sub] = args.positional;

  if (sub !== "start") {
    out.error("usage: statewave-connectors mcp start [--list-tools]");
    return 2;
  }

  const listOnly = flagAsBool(args, "list-tools");

  try {
    const mod = await import("@statewave/mcp-server");
    if (listOnly) {
      // Pipe the tool surface through the @statewave/mcp-server entry point
      // so its layout stays the single source of truth — useful for clients
      // that read schemas before connecting.
      await mod.startMcpServer({ listToolsOnly: true });
      return 0;
    }
    await mod.startMcpServer();
    return 0;
  } catch (err) {
    const e = err as { message?: string; hint?: string };
    if (e?.hint) {
      out.error(e.message ?? "MCP server failed to start", e.hint);
    } else {
      out.error(
        "failed to start MCP server: " + (e?.message ?? String(err)),
        "ensure @statewave/mcp-server is installed and STATEWAVE_URL is set; or pass --list-tools to inspect the tool surface",
      );
    }
    return 1;
  }
}
