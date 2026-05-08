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
import { startStdioServerFromEnv } from "./stdio.js";
import { STATEWAVE_MCP_TOOLS } from "./tools-registry.js";

const HELP = `statewave-mcp-server — stdio MCP server for Statewave memory

usage:
  statewave-mcp-server [--list-tools] [--help] [--version]

env:
  STATEWAVE_URL          base URL for the Statewave API (required)
  STATEWAVE_API_KEY      optional API key
  STATEWAVE_TENANT_ID    optional tenant id

flags:
  --list-tools           print the tool surface (JSON) and exit
  --help, -h             show this message
  --version, -v          print package version and exit
`;

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
    await startStdioServerFromEnv();
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
