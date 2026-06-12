#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { disableColor } from "./colors.js";
import { runDoctor } from "./commands/doctor.js";
import { runListen } from "./commands/listen.js";
import { runMcp } from "./commands/mcp.js";
import { runQuickstart } from "./commands/quickstart.js";
import { runReplay } from "./commands/replay.js";
import { runRun } from "./commands/run.js";
import { runSync } from "./commands/sync.js";
import { runTest } from "./commands/test.js";
import { runValidateConfig } from "./commands/validate-config.js";
import { CLI_VERSION } from "./version.js";

const ROOT_HELP = `statewave-connectors v${CLI_VERSION} — feed real-world events into Statewave

usage:
  statewave-connectors <command> [options]

commands:
  quickstart [--all]              zero-to-working: start a Statewave server (+admin), wire up your MCP clients, seed this repo
  doctor                          show environment diagnostics
  sync <connector> [options]      run a connector sync (--dry-run is recommended for new use)
  replay --source <name>          re-run a connector's read path against historical data
  test --connector <name>         smoke-test a connector wiring (no network)
  listen <connector> [options]    start a webhook receiver (Slack live-mode, etc.)
  validate-config [--config P]    parse the runner config (TOML) and report problems
  run [--config P]                start the hosted runner (scheduled pulls + multiplexed push receivers + /healthz)
  mcp start                       start the Statewave MCP server
  mcp init <client> [--write]     configure an MCP client (claude|claude-desktop|cursor|vscode|codex) to use Statewave memory
  mcp seed [--write]              seed this repo's git history + README into memory (so get_context isn't empty)

global flags:
  --json                          machine-readable output (no decorative lines on stdout)
  --no-color                      disable ANSI colors (also respects the NO_COLOR env var)
  --version                       print CLI version and exit
  --help, -h                      show this message; pass after a command for per-command help

env:
  STATEWAVE_URL                   base URL for the Statewave API (required for ingestion)
  STATEWAVE_API_KEY               API key, when your Statewave instance enforces auth
  STATEWAVE_TENANT_ID             tenant id, when running multi-tenant
  GITHUB_TOKEN                    only used by the github connector
  GITLAB_TOKEN                    only used by the gitlab connector (personal/project access token)
  GITLAB_URL                      only used by the gitlab connector (self-managed; or pass --host)
  BITBUCKET_TOKEN                 only used by the bitbucket connector (access token)
  GITEA_TOKEN                     only used by the gitea connector
  GITEA_URL                       only used by the gitea connector (required; or pass --host)
  AZURE_DEVOPS_PAT                only used by the azure-devops connector (personal access token)
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
  statewave-connectors sync gitlab   --repo group/project --dry-run
  statewave-connectors sync bitbucket --repo workspace/repo --dry-run
  statewave-connectors sync gitea    --host https://gitea.example.com --repo owner/repo --dry-run
  statewave-connectors sync azure-devops --repo org/project/repo --dry-run
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
  statewave-connectors mcp init claude
`;

const COMMAND_HELP: Record<string, string> = {
  quickstart: `statewave-connectors quickstart [options]

Zero-to-working in one command. It:
  1. ensures a Statewave server is up — reuses one already healthy at the URL,
     otherwise brings up api + admin + db via docker compose (published images,
     debug mode, no API keys needed);
  2. waits for the API to become healthy;
  3. configures an MCP client to use it (defaults to Claude Desktop), pointing
     at the server this CLI ships with — so it works even in GUI apps with no
     shell PATH;
  4. seeds this repo's git history + README so the first get_context isn't empty.

Then restart the client and ask it about your project.

LLM key (optional): with one, the server uses the LLM compiler + semantic
embeddings — cleaner, deduplicated, meaning-recalled memory. Without one, it
uses the built-in heuristic compiler + keyword matching: fully offline, zero
cost, coarser. When starting a fresh server interactively, quickstart offers to
take a key; it's also read from --llm-api-key, STATEWAVE_LITELLM_API_KEY, or
OPENAI_API_KEY. The key is passed to the container via env, never written to disk.

options:
  --client <ids>         comma-separated: claude,claude-desktop,cursor,vscode,codex (skips the prompt)
  --all                  configure every supported client (skips the prompt)
  --yes, -y              non-interactive: use the auto-detected clients without prompting
                         (with none of the above, quickstart shows what it detected and asks you to pick)
  --subject SUBJECT      subject to seed + scope the client to (default: repo:<dir name>)
  --statewave-url URL    use an existing server at URL instead of starting one
  --api-port N           host port for the API when starting the stack (default: 8100)
  --admin-port N         host port for the admin console (default: 8080)
  --llm-api-key KEY      enable the LLM compiler + embeddings (default model: OpenAI gpt-4o-mini)
  --llm-model ID         LiteLLM model id to use with the key (e.g. anthropic/claude-3-5-haiku)
  --no-llm               force keyless (heuristic) even if a key is in the environment
  --no-llm-prompt        don't interactively ask for a key (stay keyless unless one is in env/flags)
  --no-install-extension don't install the Statewave IDE Companion (otherwise auto-installed for any
                         chosen VS Code / Cursor — it auto-captures your work into memory)
  --extension-vsix PATH  install the IDE Companion from a local .vsix instead of the Marketplace
  --no-admin             start only api + db (skip the admin console)
  --no-seed              don't seed the repo
  --down [--purge]       stop the quickstart stack (--purge also deletes the database volume)
  --json                 machine-readable output

examples:
  statewave-connectors quickstart
  statewave-connectors quickstart --client cursor --subject repo:acme/platform
  statewave-connectors quickstart --statewave-url http://localhost:8100   # reuse, don't start docker
  statewave-connectors quickstart --down
`,
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
  jira        requires --host + --projects            (env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)
              optional --include issues,comments,transitions and --sprint-field customfield_<id>
              Server/DC: --deployment server + --personal-access-token (env: JIRA_PAT) or basic auth
  database    requires --dialect + a read source     (env: STATEWAVE_DATABASE_SOURCE_URL)
              rows mode (default): --table+--columns OR --query, plus --id-column + --max-rows
              schema mode: --mode schema + --tables (catalog metadata only; no data rows)

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
  --host URL                 jira only — Jira Cloud site base URL (or env JIRA_BASE_URL)
  --projects LIST            jira only — required project-key allowlist (e.g. ENG,PLATFORM)
  --sprint-field ID          jira only — opt-in Sprint custom-field id (e.g. customfield_10020); adds sprint context to issues
  --deployment cloud|server  jira only — cloud (default; REST v3 + email:token) or server/DC (REST v2 + PAT/basic)
  --personal-access-token T  jira server/DC only — Data Center PAT, sent as Authorization: Bearer (env: JIRA_PAT)
  --dialect NAME             database only — postgres | mysql | mariadb | mssql
  --connection-url URL       database only — prefer the STATEWAVE_DATABASE_SOURCE_URL env var; use a read-only login
  --table NAME               database rows mode — allowlisted table (or schema.table); pair with --columns
  --columns LIST             database rows mode — explicit column allowlist (no schema-wide dump)
  --query SQL                database rows mode — a single read-only SELECT (alternative to --table)
  --id-column COL            database rows mode — row id column (stable provenance + idempotency)
  --updated-at-column COL    database rows mode — column for occurred_at + incremental --since
  --max-rows N               database rows mode — hard per-run row cap (required)
  --mode rows|schema         database only — rows (default) ingests data; schema ingests catalog metadata only
  --tables LIST              database schema mode — explicit table allowlist (table or schema.table); no whole-instance crawl
  --subject-column COL       database rows mode — derive a per-row subject from a column
  --subject-prefix PREFIX    database rows mode — prefix for --subject-column values

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

push-mode connectors:
  slack       requires --channels C-IDS  (env: SLACK_SIGNING_SECRET, STATEWAVE_URL, STATEWAVE_API_KEY)
  freshdesk   shared-secret header        (env: FRESHDESK_WEBHOOK_SECRET, FRESHDESK_SUBDOMAIN, STATEWAVE_URL, STATEWAVE_API_KEY)
  zendesk     HMAC-SHA256 signature       (env: ZENDESK_WEBHOOK_SIGNING_SECRET, ZENDESK_SUBDOMAIN, STATEWAVE_URL, STATEWAVE_API_KEY)
  intercom    HMAC-SHA1 signature         (env: INTERCOM_CLIENT_SECRET, INTERCOM_APP_ID, INTERCOM_REGION, STATEWAVE_URL, STATEWAVE_API_KEY)
  gmail       Pub/Sub push + path-token  (env: GMAIL_PUBSUB_TOKEN, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_QUERY, STATEWAVE_URL, STATEWAVE_API_KEY)
  jira        HMAC-SHA256 X-Hub-Signature (env: JIRA_WEBHOOK_SECRET, JIRA_BASE_URL, STATEWAVE_URL, STATEWAVE_API_KEY)

options:
  --port N                   listen port (default: 3000)
  --host HOST                bind address (default: 0.0.0.0)
  --path PATH                webhook path (default: /<connector>/events)
  --signing-secret SECRET    overrides SLACK_SIGNING_SECRET (slack) / FRESHDESK_WEBHOOK_SECRET (freshdesk) / ZENDESK_WEBHOOK_SIGNING_SECRET (zendesk) / INTERCOM_CLIENT_SECRET (intercom) / JIRA_WEBHOOK_SECRET (jira)
  --signing-header NAME      freshdesk + jira — custom signature/secret header name (freshdesk default X-Statewave-Token; jira default X-Hub-Signature)
  --base-url URL             jira only — Jira site base URL (env: JIRA_BASE_URL); used to mint /browse/<KEY> permalinks
  --projects LIST            jira only — optional project-key allowlist; events outside it are acked + skipped
  --subdomain SUB            freshdesk + zendesk — used to mint browser permalinks on emitted episodes
  --app-id ID                intercom only — workspace/app id for browser permalinks
  --region us|eu|au          intercom only — picks the right app.<region>.intercom.com host (default: us)
  --replay-window-sec N      zendesk only — replay-protection window for the signed timestamp (default: 300)
  --path-token TOK           gmail only — random secret in the Pub/Sub subscription URL (env: GMAIL_PUBSUB_TOKEN)
  --client-id ID             gmail only — OAuth client id (env: GMAIL_CLIENT_ID)
  --client-secret SECRET     gmail only — OAuth client secret (env: GMAIL_CLIENT_SECRET)
  --refresh-token TOK        gmail only — OAuth refresh token (env: GMAIL_REFRESH_TOKEN)
  --query Q                  gmail only — Gmail search query applied to delta-sync results
  --label-ids LIST           gmail only — typed label-id allowlist (e.g. INBOX,IMPORTANT)
  --max-items N              gmail only — cap mapped episodes per Pub/Sub delivery
  --accept-dms               slack only — (v0.4.0) dispatch message.im events to slack.dm.* on dm:<user>
  --accept-mpim              slack only — (v0.4.0) dispatch message.mpim events to slack.mpim.* on mpim:<channel>
  --json                     machine-readable startup output

slack only delivers channel IDs (C…), so the allowlist must use IDs:

  export SLACK_SIGNING_SECRET=...
  export STATEWAVE_URL=http://localhost:8100
  export STATEWAVE_API_KEY=...
  statewave-connectors listen slack --channels C01ABCDEF,C02XYZ123 --port 3000

Then point your Slack app's Event Subscriptions URL at the public address
(via ngrok / Cloudflare Tunnel / your own ingress).
`,
  mcp: `statewave-connectors mcp <start|init|seed> [options]

mcp start [--http] [--list-tools] [--json]
  starts (or guides toward) the Statewave MCP server. Requires STATEWAVE_URL.
  --list-tools   print the tool surface (JSON) and exit without connecting
  --http         serve the Streamable HTTP transport (for remote clients —
                 Claude.ai, ChatGPT — and team/hosted memory) instead of stdio
  --host / --port / --path        HTTP bind address / port / endpoint path
  --auth-token TOKEN              require Authorization: Bearer TOKEN on HTTP (or STATEWAVE_MCP_AUTH_TOKEN)
    local clients (Claude Code/Desktop, Cursor, Codex) use the default stdio transport.

mcp init <client> [--write] [options]
  configures an MCP client to use the Statewave memory server. Prints the
  config + instruction block by default (writes nothing); pass --write to apply.

  clients:
    claude          Claude Code        → .mcp.json + CLAUDE.md
    claude-desktop  Claude Desktop     → claude_desktop_config.json (paste guidance into custom instructions)
    cursor          Cursor             → .cursor/mcp.json + AGENTS.md
    vscode          VS Code (Copilot)  → .vscode/mcp.json + .github/copilot-instructions.md
    codex           Codex CLI          → ~/.codex/config.toml + AGENTS.md

  options:
    --write                apply the changes (merges into existing files; never clobbers other servers)
    --subject SUBJECT      memory subject the assistant reads/writes (default: repo:<dir name>)
    --statewave-url URL    server URL written into the config (default: http://localhost:8100)
    --name NAME            MCP server id (default: statewave)
    --tenant ID            STATEWAVE_TENANT_ID for multi-tenant servers
    --server-bin PATH      launch a local mcp-server bin (via the current node) instead of npx — for dev/testing
    --server-command CMD   command used to launch --server-bin (default: the current node executable)
    --json                 machine-readable output

  API keys are never written to config files — the server reads STATEWAVE_API_KEY
  from its environment. examples:
    statewave-connectors mcp init claude
    statewave-connectors mcp init cursor --subject repo:acme/platform --write
    statewave-connectors mcp init vscode --statewave-url https://memory.acme.dev --write

mcp seed [--write] [options]
  seeds the current repo's local git history + README into Statewave so the
  first get_context returns real answers instead of an empty brain. Reads git
  and the filesystem only — no tokens, no network — and is dry-run by default.

  options:
    --write                ingest the episodes and compile the subject (requires STATEWAVE_URL)
    --subject SUBJECT      memory subject to seed (default: repo:<dir name>)
    --max-commits N        how many recent commits to ingest (default: 200)
    --no-docs              skip the README overview episode (commits only)
    --concurrency N        parallel ingest requests, shows live progress (default: 8, max: 32)
    --statewave-url URL    server URL (or set STATEWAVE_URL)
    --json                 machine-readable output

  re-running is safe: commits dedupe on their sha and the README updates in
  place. examples:
    statewave-connectors mcp seed
    statewave-connectors mcp seed --subject repo:acme/platform --write
`,
  run: `statewave-connectors run [--config <path>] [--json]

The hosted runner. Loads a TOML config and:

  - Schedules every \`[[pull.<kind>]]\` source on its own interval (cron
    or \`every <N><s|m|h|d>\`); each tick instantiates the right
    connector, runs sync, ingests episodes, persists the cursor.
  - Multiplexes every \`[[push.<kind>]]\` receiver under one HTTP server
    at \`/<kind>/<name>/events\`. Each receiver gets the runner's shared
    ingest sink; signature verification, dedup, and retry semantics are
    inherited from the per-connector receiver factory.
  - Exposes \`/healthz\` (200 once listening) and \`/readyz\` (200 between
    start and stop) for orchestrator probes; both unauthenticated.
  - Exposes \`/metrics\` in Prometheus text format with per-source pull
    counters, per-receiver push counters (deliveries / responses /
    handler errors / duration histogram), and the prom-client default
    Node process metrics. Path overridable; auth is none / basic /
    bearer (configured under [runner.metrics.auth]). Health endpoints
    are unauthenticated regardless.
  - Handles SIGTERM / SIGINT — drain in-flight requests, stop schedules,
    close the server. \`stop()\` is idempotent.

Config search order (first match wins):
  1. --config <path>
  2. \$STATEWAVE_CONNECTORS_CONFIG
  3. ./statewave-connectors.toml
  4. \$XDG_CONFIG_HOME/statewave-connectors/config.toml  (defaults to ~/.config)

State (Wave 3): per-source cursors persist via the [runner.state]
config block — kinds: \`memory\` (default; lost on restart), \`file\`
(atomic JSON-file write; right for single-process daemons), \`postgres\`
(\`INSERT...ON CONFLICT\`; right for multi-process behind a load
balancer), \`redis\` (HSET/HGET on a single hash). \`pg\` and \`ioredis\`
are optional peer deps — install only the one you select.

Push receiver dedup caches are still in-memory in this release; the
upstream system's stable event-id means the Statewave server's
idempotency layer absorbs any duplicates that slip through after a
restart.

Run \`statewave-connectors validate-config\` first to catch schema /
env-var problems statically. The \`run\` command will refuse to start
on the same errors, but in production you want this caught at deploy
time, not pod-start time.
`,
  "validate-config": `statewave-connectors validate-config [--config <path>] [--json]

Parses the runner config (TOML) and reports every problem in one pass:
schema issues, unknown connector kinds, missing required fields, duplicate
\`name\`s within a kind, and unresolved \`\${VAR}\` references. Reports zero
on stdout when the config is well-formed; non-zero exit codes:

  2  config not found / missing env / validation issues (operator-fixable)
  1  unexpected internal failure (parse error, file read, etc.)

config file search order (first match wins):
  1. --config <path>
  2. \$STATEWAVE_CONNECTORS_CONFIG
  3. ./statewave-connectors.toml
  4. \$XDG_CONFIG_HOME/statewave-connectors/config.toml  (defaults to ~/.config)

\${VAR} interpolation is env-only; \${VAR:-fallback} supplies a default
when VAR is unset or empty. \$\$ escapes a literal \`\$\`.

This is a static check — no network calls, no daemon. Pair with
\`doctor\` to also smoke-test the source-system credentials.
`,
};

function printCommandHelp(name: string): void {
  process.stdout.write(COMMAND_HELP[name] ?? ROOT_HELP);
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--no-color")) disableColor();
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
    case "validate-config":
      return runValidateConfig(args);
    case "run":
      return runRun(args);
    case "mcp":
      return runMcp(args);
    case "quickstart":
      return runQuickstart(args);
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
