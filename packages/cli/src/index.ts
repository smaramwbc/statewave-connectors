#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { runDoctor } from "./commands/doctor.js";
import { runMcp } from "./commands/mcp.js";
import { runReplay } from "./commands/replay.js";
import { runSync } from "./commands/sync.js";
import { runTest } from "./commands/test.js";
import { CLI_VERSION } from "./version.js";

const ROOT_HELP = `statewave-connectors v${CLI_VERSION} — feed real-world events into Statewave

usage:
  statewave-connectors <command> [options]

commands:
  doctor                          show environment diagnostics
  sync <connector> [options]      run a connector sync (--dry-run is recommended for new use)
  replay --source <name>          re-run a connector's read path against historical data
  test --connector <name>         smoke-test a connector wiring (no network)
  mcp start                       start the Statewave MCP server

global flags:
  --json                          machine-readable output (no decorative lines on stdout)
  --version                       print CLI version and exit
  --help, -h                      show this message; pass after a command for per-command help

env:
  STATEWAVE_URL                   base URL for the Statewave API (required for ingestion)
  STATEWAVE_API_KEY               API key, when your Statewave instance enforces auth
  STATEWAVE_TENANT_ID             tenant id, when running multi-tenant
  GITHUB_TOKEN                    only used by the github connector

quickstart:
  statewave-connectors doctor
  statewave-connectors sync github   --repo OWNER/NAME --subject repo:OWNER/NAME --dry-run
  statewave-connectors sync markdown --path ./docs     --subject repo:OWNER/NAME --dry-run
  statewave-connectors mcp start
`;

const COMMAND_HELP: Record<string, string> = {
  doctor: `statewave-connectors doctor — environment diagnostics

usage:
  statewave-connectors doctor [--json]

reports:
  cli + node + platform versions
  STATEWAVE_URL / STATEWAVE_API_KEY / STATEWAVE_TENANT_ID
  GITHUB_TOKEN (only relevant if you use the github connector)
`,
  sync: `statewave-connectors sync <connector> [options]

connectors (Phase 1):
  github      requires --repo OWNER/NAME
  markdown    requires --path PATH

common options:
  --subject SUBJECT          memory subject (e.g. repo:owner/name, customer:acme)
  --since YYYY-MM-DD         earliest event time the connector should consider
  --max-items N              cap mapped episodes
  --include LIST             comma-separated allow-list (connector-specific)
  --exclude LIST             comma-separated deny-list (connector-specific)
  --cursor TOKEN             resume from a previously persisted cursor
  --dry-run                  print mapped episodes without ingesting (recommended for new use)
  --json                     machine-readable output
  --redact-email             strip email addresses from episode text
  --redact-phone             strip phone-shaped digits
  --redact-secrets           best-effort scrub of common API keys / tokens

examples:
  statewave-connectors sync github   --repo smaramwbc/statewave --subject repo:smaramwbc/statewave --dry-run
  statewave-connectors sync github   --repo smaramwbc/statewave --include prs,releases --since 2026-01-01 --dry-run
  statewave-connectors sync markdown --path ./docs --subject repo:smaramwbc/statewave --dry-run --json
`,
  replay: `statewave-connectors replay --source <name> [--since YYYY-MM-DD] [--json]

re-runs a connector's read path. Output is dry-run by default — pass --no-dry-run
to ingest into Statewave.
`,
  test: `statewave-connectors test --connector <name> [--json]

loads the connector module and confirms its factory is exported. No network calls.
`,
  mcp: `statewave-connectors mcp start [--json]

starts (or guides toward) the Statewave MCP server. Requires STATEWAVE_URL.
`,
};

function printCommandHelp(name: string): void {
  process.stdout.write(COMMAND_HELP[name] ?? ROOT_HELP);
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0) {
    process.stdout.write(ROOT_HELP);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  if (argv[0] === "help") {
    const target = argv[1];
    if (target && target in COMMAND_HELP) {
      printCommandHelp(target);
      return 0;
    }
    process.stdout.write(ROOT_HELP);
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    const cmd = argv.find((a) => !a.startsWith("-"));
    if (cmd && cmd in COMMAND_HELP) {
      printCommandHelp(cmd);
      return 0;
    }
    process.stdout.write(ROOT_HELP);
    return 0;
  }

  const args = parseArgs(argv);
  const command = args.positional[0];

  switch (command) {
    case "doctor":
      return runDoctor(args);
    case "sync":
      return runSync(args);
    case "replay":
      return runReplay(args);
    case "test":
      return runTest(args);
    case "mcp":
      return runMcp(args);
    default:
      process.stderr.write(
        `unknown command: ${command}\nrun "statewave-connectors --help" for usage.\n`,
      );
      return 2;
  }
}

// Detect "we were invoked as the entry point" robustly across direct invocation
// (`node dist/index.js`) and the npm bin shim, which on macOS resolves through
// a symlink (`node_modules/.bin/foo` → `node_modules/<pkg>/dist/index.js`). A
// naive `import.meta.url === \`file://${process.argv[1]}\`` comparison fails
// in the symlinked-bin case because `process.argv[1]` is the link path and
// `import.meta.url` is the real path. We compare resolved paths instead.
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

let isMain = false;
try {
  const arg = process.argv[1];
  if (arg) {
    isMain = realpathSync(arg) === fileURLToPath(import.meta.url);
  }
} catch {
  isMain = false;
}

if (isMain) {
  main().then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
