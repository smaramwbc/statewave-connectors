#!/usr/bin/env node
// Bin entry point for the `statewave-mcp-server` command.
//
// Kept separate from `index.ts` (the library entry) so that:
//   - importing `@statewavedev/mcp-server` never has bin-side effects
//   - the bin can carry the shebang + entry-point logic without polluting
//     the type-driven import surface
//   - clients that want the stdio loop programmatically import
//     `runStdioServer` / `startStdioServerFromEnv` directly from index.

import { ConnectorError } from "@statewavedev/connectors-core";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { startHttpServerFromEnv, DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, DEFAULT_HTTP_PATH } from "./http.js";
import { startStdioServerFromEnv } from "./stdio.js";
import { STATEWAVE_MCP_TOOLS } from "./tools-registry.js";

const HELP = `statewave-mcp-server — MCP server for Statewave memory

usage:
  statewave-mcp-server [--http] [--list-tools] [--help] [--version]

transports:
  (default)              stdio JSON-RPC — for local clients (Claude Code/Desktop, Cursor, Codex)
  --http                 Streamable HTTP — for remote clients (Claude.ai, ChatGPT) and team/hosted memory

env:
  STATEWAVE_URL              base URL for the Statewave API (required)
  STATEWAVE_API_KEY          optional API key
  STATEWAVE_TENANT_ID        optional tenant id
  STATEWAVE_MCP_AUTH_TOKEN   optional bearer token required on HTTP requests

http flags:
  --host HOST            bind address (default ${DEFAULT_HTTP_HOST}; use 0.0.0.0 to expose, behind TLS + token)
  --port PORT            listen port (default ${DEFAULT_HTTP_PORT})
  --path PATH            endpoint path (default ${DEFAULT_HTTP_PATH})
  --auth-token TOKEN     require Authorization: Bearer TOKEN (or set STATEWAVE_MCP_AUTH_TOKEN)

flags:
  --list-tools           print the tool surface (JSON) and exit
  --help, -h             show this message
  --version, -v          print package version and exit
`;

function flagValue(argv: ReadonlyArray<string>, name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) return argv[i + 1];
  return undefined;
}

// Bumped at release time alongside packages/mcp-server/package.json.
const SERVER_VERSION = "0.1.0";

async function main(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }

  if (argv.includes("--list-tools")) {
    process.stdout.write(
      JSON.stringify(
        {
          server: "statewave-mcp-server",
          version: SERVER_VERSION,
          statewave_url: process.env.STATEWAVE_URL ?? null,
          tools: STATEWAVE_MCP_TOOLS,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  try {
    if (argv.includes("--http")) {
      const port = flagValue(argv, "--port");
      await startHttpServerFromEnv({
        host: flagValue(argv, "--host"),
        port: port ? Number.parseInt(port, 10) : undefined,
        path: flagValue(argv, "--path"),
        authToken: flagValue(argv, "--auth-token"),
      });
    } else {
      await startStdioServerFromEnv();
    }
    return 0;
  } catch (err) {
    if (err instanceof ConnectorError) {
      process.stderr.write(`error: ${err.message}\n`);
      if (err.hint) process.stderr.write(`hint:  ${err.hint}\n`);
      return err.code === "config_invalid" ? 2 : 1;
    }
    process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
    return 1;
  }
}

let isMain = false;
try {
  const arg = process.argv[1];
  if (arg) isMain = realpathSync(arg) === fileURLToPath(import.meta.url);
} catch {
  isMain = false;
}

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
