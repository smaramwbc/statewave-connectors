import type { ParsedArgs } from "../args.js";
import { flagAsBool, flagAsString } from "../args.js";
import { Output } from "../output.js";
import { runMcpInit } from "./mcp-init.js";
import { runMcpSeed } from "./mcp-seed.js";

export async function runMcp(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const [, sub] = args.positional;

  if (sub === "init") {
    return runMcpInit(args);
  }

  if (sub === "seed") {
    return runMcpSeed(args);
  }

  if (sub !== "start") {
    out.error("usage: statewave-connectors mcp <start|init|seed> [options]");
    return 2;
  }

  const listOnly = flagAsBool(args, "list-tools");
  const useHttp = flagAsBool(args, "http");

  try {
    const mod = await import("@statewavedev/mcp-server");
    if (listOnly) {
      // Pipe the tool surface through the @statewavedev/mcp-server entry point
      // so its layout stays the single source of truth — useful for clients
      // that read schemas before connecting.
      await mod.startMcpServer({ listToolsOnly: true });
      return 0;
    }
    if (useHttp) {
      const port = flagAsString(args, "port");
      await mod.startMcpServer({
        transport: "http",
        http: {
          host: flagAsString(args, "host"),
          port: port ? Number.parseInt(port, 10) : undefined,
          path: flagAsString(args, "path"),
          authToken: flagAsString(args, "auth-token"),
        },
      });
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
        "ensure @statewavedev/mcp-server is installed and STATEWAVE_URL is set; or pass --list-tools to inspect the tool surface",
      );
    }
    return 1;
  }
}
