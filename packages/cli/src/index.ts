#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { runDoctor } from "./commands/doctor.js";
import { runListen } from "./commands/listen.js";
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
  listen <connector> [options]    start a webhook receiver (Slack live-mode, etc.)
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
  SLACK_BOT_TOKEN                 only used by the slack connector (xoxb-…)
  N8N_API_KEY                     only used by the n8n connector
  N8N_INSTANCE_URL                only used by the n8n connector (or pass --instance-url)
  DISCORD_BOT_TOKEN               only used by the discord connector
  ZENDESK_SUBDOMAIN               only used by the zendesk connector (or pass --subdomain)
  ZENDESK_EMAIL                   only used by the zendesk connector (api_token mode)
  ZENDESK_API_TOKEN               only used by the zendesk connector (api_token mode)
  ZENDESK_OAUTH_TOKEN             only used by the zendesk connector (oauth mode)
  INTERCOM_ACCESS_TOKEN           only used by the intercom connector
  INTERCOM_REGION                 only used by the intercom connector (us | eu | au; default: us)
  INTERCOM_APP_ID                 only used by the intercom connector (workspace id; for permalinks)
  FRESHDESK_SUBDOMAIN             only used by the freshdesk connector (or pass --subdomain)
  FRESHDESK_API_KEY               only used by the freshdesk connector
  NOTION_API_TOKEN                only used by the notion connector
  GMAIL_CLIENT_ID                 only used by the gmail connector (OAuth client id)
  GMAIL_CLIENT_SECRET             only used by the gmail connector (OAuth client secret)
  GMAIL_REFRESH_TOKEN             only used by the gmail connector (OAuth refresh token)
  GMAIL_QUERY                     only used by the gmail connector (or pass --query)

quickstart:
  statewave-connectors doctor
  statewave-connectors sync github   --repo OWNER/NAME --subject repo:OWNER/NAME --dry-run
  statewave-connectors sync markdown --path ./docs     --subject repo:OWNER/NAME --dry-run
  statewave-connectors sync slack    --channels general,support --subject team:acme --dry-run
  statewave-connectors sync n8n      --workflows 1,42 --instance-url https://n8n.example.com --dry-run
  statewave-connectors sync discord  --guild G01ABC --channels general,help --dry-run
  statewave-connectors sync zendesk  --subdomain acme --since 2026-01-01 --dry-run
  statewave-connectors sync intercom --since 2026-01-01 --dry-run
  statewave-connectors sync freshdesk --subdomain acme --since 2026-01-01 --dry-run
  statewave-connectors sync notion   --subject repo:acme/platform --dry-run
  statewave-connectors sync gmail    --query 'label:inbox newer_than:30d' --dry-run
  statewave-connectors listen slack  --channels C01ABCDEF --port 3000
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
  SLACK_BOT_TOKEN (only relevant if you use the slack connector)
  N8N_API_KEY / N8N_INSTANCE_URL (only relevant if you use the n8n connector)
  DISCORD_BOT_TOKEN (only relevant if you use the discord connector)
`,
  sync: `statewave-connectors sync <connector> [options]

connectors:
  github      requires --repo OWNER/NAME            (env: GITHUB_TOKEN)
  markdown    requires --path PATH
  slack       requires --channels LIST, --include-dms, or --include-mpim  (env: SLACK_BOT_TOKEN)
  n8n         requires --workflows LIST + --instance-url URL  (env: N8N_API_KEY, N8N_INSTANCE_URL)
  discord     requires --guild ID + --channels LIST (env: DISCORD_BOT_TOKEN)
  zendesk     requires --subdomain + auth           (env: ZENDESK_SUBDOMAIN + ZENDESK_API_TOKEN/ZENDESK_EMAIL or ZENDESK_OAUTH_TOKEN)
  intercom    requires --access-token               (env: INTERCOM_ACCESS_TOKEN; INTERCOM_REGION us|eu|au)
  freshdesk   requires --subdomain + --api-key       (env: FRESHDESK_SUBDOMAIN, FRESHDESK_API_KEY)
  notion      requires --api-token                   (env: NOTION_API_TOKEN); optional --databases scopes to specific databases
  gmail       requires --client-id + --client-secret + --refresh-token + --query
                                                     (env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_QUERY)

helpers (no sync — push-mode integrations):
  zapier      use @statewavedev/connectors-zapier with "Webhooks by Zapier" — see package README

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

connector-specific:
  --repo OWNER/NAME          github only
  --path PATH                markdown only
  --channels LIST            slack only — channel ids (C…) or names (#general, general)
  --include-dms              slack only — also ingest DMs the bot has access to (im:read + im:history scopes)
  --include-mpim             slack only — also ingest multi-party DMs the bot is in (mpim:read + mpim:history scopes)
  --resolve-users            slack only — expand <@Uxxx> mentions to display names (extra API calls)
  --workflows LIST           n8n only — workflow ids or names
  --instance-url URL         n8n only — base URL of the n8n instance (or set N8N_INSTANCE_URL)
  --guild ID                 discord only — guild (server) id
  --channels LIST            discord only — channel ids (snowflake) or names
  --subdomain SUB            zendesk + freshdesk — e.g. acme for https://acme.zendesk.com / https://acme.freshdesk.com
  --email EMAIL              zendesk only — pairs with --api-token (api_token mode)
  --api-token TOKEN          zendesk + notion — paired with --email for zendesk (api_token mode); standalone bearer token for notion
  --oauth-token TOKEN        zendesk only — already-issued OAuth bearer token (oauth mode)
  --brands LIST              zendesk only — brand id allowlist (numeric ids, comma-separated)
  --statuses LIST            zendesk only — status allowlist (new,open,pending,hold,solved,closed)
  --use-incremental          zendesk only — bootstrap delta sync from sync #1 via the Incremental Tickets Export API (admin-only)
  --access-token TOKEN       intercom only — personal access token or OAuth access token
  --region us|eu|au          intercom only — workspace region (default: us)
  --app-id ID                intercom only — workspace id for permalinks (optional)
  --tags LIST                intercom only — tag-name allowlist (case-sensitive)
  --teams LIST               intercom only — team_assignee_id allowlist
  --api-key KEY              freshdesk only — API key from profile settings
  --client-id ID             gmail only — OAuth client id
  --client-secret SECRET     gmail only — OAuth client secret
  --refresh-token TOKEN      gmail only — OAuth refresh token (one-time-issued, long-lived)
  --query Q                  gmail only — Gmail search query (e.g. 'label:inbox after:2026/01/01')
  --label-ids LIST           gmail only — server-side label allowlist (AND semantics; e.g. INBOX,IMPORTANT)
  --databases LIST           notion only — database id allowlist; scopes the pull to /v1/databases/{id}/query instead of workspace-wide search

examples:
  statewave-connectors sync github   --repo smaramwbc/statewave --subject repo:smaramwbc/statewave --dry-run
  statewave-connectors sync github   --repo smaramwbc/statewave --include prs,releases --since 2026-01-01 --dry-run
  statewave-connectors sync markdown --path ./docs --subject repo:smaramwbc/statewave --dry-run --json
  statewave-connectors sync slack    --channels general,support --subject team:acme --since 2026-01-01 --dry-run
  statewave-connectors sync n8n      --workflows "Daily ETL,42" --instance-url https://n8n.example.com --since 2026-01-01 --dry-run
  statewave-connectors sync discord  --guild 1100000000000000000 --channels general,help --dry-run
  statewave-connectors sync zendesk  --subdomain acme --since 2026-01-01 --dry-run
  statewave-connectors sync zendesk  --subdomain acme --include tickets,comments --dry-run
  statewave-connectors sync intercom --since 2026-01-01 --dry-run
  statewave-connectors sync intercom --include conversations,parts --region eu --dry-run
  statewave-connectors sync freshdesk --subdomain acme --since 2026-01-01 --dry-run
  statewave-connectors sync freshdesk --subdomain acme --include tickets,conversations --dry-run
  statewave-connectors sync notion   --subject repo:acme/platform --dry-run
  statewave-connectors sync notion   --include pages,content --dry-run
  statewave-connectors sync gmail    --query 'label:inbox newer_than:30d' --dry-run
  statewave-connectors sync gmail    --query 'from:foo@bar.com after:2026/01/01' --max-items 50 --dry-run
`,
  replay: `statewave-connectors replay --source <name> [--since YYYY-MM-DD] [--json]

re-runs a connector's read path. Output is dry-run by default — pass --no-dry-run
to ingest into Statewave.
`,
  test: `statewave-connectors test --connector <name> [--json]

loads the connector module and confirms its factory is exported. No network calls.
`,
  listen: `statewave-connectors listen <connector> [options]

push-mode connectors (Phase 2):
  slack       requires --channels C-IDS  (env: SLACK_SIGNING_SECRET, STATEWAVE_URL, STATEWAVE_API_KEY)

options:
  --port N                   listen port (default: 3000)
  --host HOST                bind address (default: 0.0.0.0)
  --path /slack/events       webhook path (default: /slack/events)
  --signing-secret SECRET    overrides SLACK_SIGNING_SECRET
  --json                     machine-readable startup output

slack only delivers channel IDs (C…), so the allowlist must use IDs:

  export SLACK_SIGNING_SECRET=...
  export STATEWAVE_URL=http://localhost:8100
  export STATEWAVE_API_KEY=...
  statewave-connectors listen slack --channels C01ABCDEF,C02XYZ123 --port 3000

Then point your Slack app's Event Subscriptions URL at the public address
(via ngrok / Cloudflare Tunnel / your own ingress).
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
    case "listen":
      return runListen(args);
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
