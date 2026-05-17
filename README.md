# Statewave Connectors

[![CI](https://github.com/smaramwbc/statewave-connectors/workflows/CI/badge.svg)](https://github.com/smaramwbc/statewave-connectors/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@statewavedev/connectors-core?label=%40statewavedev%2Fconnectors-core)](https://www.npmjs.com/package/@statewavedev/connectors-core)
[![Docker Pulls](https://img.shields.io/docker/pulls/statewavedev/statewave-connectors-runner?label=docker%20pulls)](https://hub.docker.com/r/statewavedev/statewave-connectors-runner)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Feed real-world events into Statewave.

Statewave Connectors turn GitHub issues, pull requests, Slack threads, Discord questions, support tickets, docs, email, and automation events into Statewave episodes.

Your agents can then retrieve compact, relevant memory by subject — instead of stuffing raw chat history or rebuilding a custom RAG pipeline for every tool.

Connectors talk to Statewave over its HTTP API and run as a standalone service — so they work with **any** Statewave app regardless of language (Python, Go, Rust, TypeScript). You don't need a Node app, or even Node installed, to use them.

> 📋 **Issues & feature requests** for the entire Statewave workspace are tracked centrally on [`smaramwbc/statewave`](https://github.com/smaramwbc/statewave/issues) — including connector-specific bugs. Issues are disabled on this repo so all reports funnel to one place.

## Why

Most "agent memory" implementations are limited to live chat transcripts. Real teams have memory in many places: GitHub history, Slack threads, support tickets, ADRs, email threads, workflow runs. Statewave is open memory infrastructure that holds all of those as **episodes**, compiles them into durable memories per **subject**, and serves compact context to agents on demand.

This repository is the connector ecosystem for that.

## Two ways to run connectors

Connectors are independent of your application's language. Pick whichever fits your stack:

**1. As a deployed service — recommended, no Node required.** Run the prebuilt runner container next to your app, the same way you'd run Postgres or Redis, and point it at your Statewave instance with a small TOML config. This is the path to use when your app is **Python, Go, Rust** — anything that isn't itself a Node service.

```sh
docker run --rm -p 3000:3000 \
  -v $PWD/statewave-connectors.toml:/config/statewave-connectors.toml:ro \
  -e STATEWAVE_URL=https://your-instance \
  -e STATEWAVE_API_KEY=… \
  statewavedev/statewave-connectors-runner:latest
```

Compose / Helm / Fly / Railway recipes ship in [`deploy/`](deploy/) — see [docs/deployment.md](docs/deployment.md).

**2. As npm packages — for embedding in a Node app.** This is a monorepo for development, but each connector ships as its own published package, so **you install only what you need.**

```sh
npm install @statewavedev/connectors-github
npm install @statewavedev/connectors-markdown
npm install @statewavedev/connectors-slack
npm install @statewavedev/connectors-n8n
npm install @statewavedev/connectors-zapier
npm install @statewavedev/connectors-discord
npm install @statewavedev/mcp-server
```

You do not need to install Slack to use the GitHub connector. The convenience meta-package `@statewavedev/connectors` exists for the rare case where you want all official connectors at once — it is **not** required for normal usage.

> **Using Statewave from Python?** You have full connector coverage today via path 1: the container ingests GitHub / Slack / Notion / support tickets into the same instance your `pip install statewave` app reads from. There is no separate "Python connectors" package because connectors are a service, not an SDK binding.

## Status — v0.17.0 (current release wave)

Every connector that supports a push surface in its source system now has a real-time receiver alongside its pull connector. The **Tier 2 push-receiver wave** (v0.7.0–v0.11.0) is complete — `statewave-connectors listen <connector>` is the unified daemon. The **Tier 3 operator/cloud productization wave** (v0.12.0–v0.17.0) is also complete — TOML config file (multi-instance), hosted runner (`statewave-connectors run`), persistent state adapters (file / Postgres / Redis), built-in OIDC verification for Gmail Pub/Sub, auth-gated Prometheus `/metrics`, and deployment recipes (Docker / Compose / Helm / Fly / Railway).

| Package | Latest | Notes |
|---|---|---|
| `@statewavedev/connectors-core` | `0.1.0` | Connector contract, episode schema, builder, idempotency, retry, redaction, source-state |
| `@statewavedev/connectors-cli` | `0.1.0` | `statewave-connectors` CLI — doctor, sync, replay, test, listen, mcp; per-command help; JSON output |
| `@statewavedev/mcp-server` | `0.1.0` | Tool definitions, `StatewaveClient`, input-validating dispatcher, stdio JSON-RPC 2.0 transport |
| `@statewavedev/connectors-github` | `0.1.0` | Issues, PRs, issue + PR comments, PR reviews, releases. Maps to `github.*` kinds. |
| `@statewavedev/connectors-markdown` | `0.1.0` | `.md` / `.mdx` scan, frontmatter, decision/ADR/RFC detection, content-hash idempotency |
| `@statewavedev/ide-core` | `0.1.0` | Editor-independent IDE Companion core — workspace scan, project summary, file classification, subject strategy, `ide.*` episode mapping, redaction + `StatewaveClient` reuse |
| `statewave-ide-companion` | `0.1.0` | VS Code / Cursor extension (private, VSIX). Preview-first, opt-in `autoIndex`. Does **not** read Copilot/Cursor chat. |
| `@statewavedev/connectors-slack` | `0.4.0` | Pull (channel + thread history) + Events-API webhook (messages, reactions, pins) + opt-in DMs (`dm:<user>`) + opt-in MPIM/group-DMs (`mpim:<channel>`). v0.4.0 dispatches DM/MPIM events through the webhook handler too (`slack.dm.*`, `slack.mpim.*`). |
| `@statewavedev/connectors-n8n` | `0.1.0` | Workflow executions, failures, and per-node errors. Maps to `n8n.workflow.executed`, `n8n.workflow.failed`, `n8n.node.errored`. |
| `@statewavedev/connectors-zapier` | `0.1.0` | Push-mode helper. `formatZapToEpisode()` for users who route Zapier "Webhooks by Zapier → POST" payloads through their own server. See package README for the direct-from-Zapier (no-code) path too. |
| `@statewavedev/connectors-discord` | `0.1.0` | Server channel + thread history pull. Maps to `discord.message.posted` and `discord.thread.replied`. |
| `@statewavedev/connectors-zendesk` | `0.2.0` | Pull (tickets + comments, with `--brands` / `--statuses` allowlists and Incremental Tickets Export delta sync) + webhook receiver (HMAC-SHA256, trigger and event-driven payloads). Customer-scoped subjects (`customer:<org_or_requester_id>`). Maps to `zendesk.ticket.created`, `zendesk.ticket.solved`, `zendesk.comment.posted`, `zendesk.comment.internal_note`. |
| `@statewavedev/connectors-intercom` | `0.2.0` | Pull (conversations + replies + admin notes, with `--tags` / `--teams` allowlists, US/EU/AU regions) + webhook receiver (HMAC-SHA1 / `X-Hub-Signature`). Customer-scoped subjects (`customer:<company_or_contact_id>`). Maps to `intercom.conversation.created`, `intercom.conversation.closed`, `intercom.conversation.replied`, `intercom.conversation.note_added`. |
| `@statewavedev/connectors-freshdesk` | `0.2.0` | Pull (tickets + conversations, with native `updated_since` server-side `--since` filter) + webhook receiver (shared-secret header). Customer-scoped subjects (`customer:<company_or_requester_id>`). Maps to `freshdesk.ticket.created`, `freshdesk.ticket.resolved`, `freshdesk.conversation.posted`, `freshdesk.conversation.internal_note`. |
| `@statewavedev/connectors-notion` | `0.1.2` | Pages (and optional body content) + opt-in page-level comments + (v0.1.2) `--databases` allowlist for database-scoped pulls. Decision-memory subjects (`workspace:notion` by default; operator overrides via `--subject`). Maps to `notion.page.created`, `notion.page.updated`, `notion.comment.posted`. Bearer token auth. |
| `@statewavedev/connectors-gmail` | `0.2.0` | Pull (Gmail-query–scoped messages, with `--label-ids` server-side filter and History-API delta sync via `--cursor`) + Cloud Pub/Sub push receiver (path-token auth; persistent per-mailbox cursor; cold-start + stale-cursor handling). Relationship-memory subjects (`relationship:<other_email>`). Maps to `gmail.message.received`, `gmail.message.sent`. |
| `@statewavedev/connectors` | `0.1.0` | Convenience meta-package — re-exports all shipped connectors. Optional. |

All v0.1 connectors, the v0.5 + v0.6 polish waves, the Tier 2 push-receiver wave (v0.7.0–v0.11.0), and the Tier 3 operator/cloud productization wave (v0.12.0–v0.17.0) have shipped. Long-running daemon shapes (Slack Socket Mode, Discord Gateway, Gmail service-account auth) are still queued. See [RELEASE_NOTES.md](RELEASE_NOTES.md) for the full release history and [docs/roadmap.md](docs/roadmap.md) for what's next.

**Capabilities today:**

- Doctor reports cli + node + platform versions and per-env-var diagnostics
- Pull mode (`statewave-connectors sync <connector>`) with `--include`, `--exclude`, `--since`, `--max-items`, `--json`, `--dry-run` across all connectors; per-connector flags for filtering (e.g. Slack `--channels`, Gmail `--query`, Zendesk `--brands`, Intercom `--tags`, Notion `--databases`)
- Cursor-based delta sync (`--cursor`) on Zendesk (Incremental Tickets Export), Gmail (History API), and Notion (database scoping) so re-runs only fetch what changed
- Push mode (`statewave-connectors listen <connector>`) for Slack (Events-API + DM/MPIM), Freshdesk (shared-secret header), Zendesk (HMAC-SHA256), Intercom (HMAC-SHA1 / `X-Hub-Signature`), and Gmail (Cloud Pub/Sub) — same `(Request) => Promise<Response>` factory mounts on Vercel / Cloudflare / Express identically across the lineup
- MCP `StatewaveClient` against the Statewave v1 HTTP API (auth, tenant, network errors mapped to typed `ConnectorError`s)
- MCP tool dispatcher with input validation for all 5 canonical tools
- `mcp start --list-tools` prints the canonical tool surface
- HTTP MCP transport is planned; the bundled stdio transport (~120 LOC, no external deps) covers `initialize` / `tools/list` / `tools/call` / `ping` / `shutdown` for any MCP-compatible client today

See [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Quickstart

> Not running a Node app? You don't need any of this — see [Two ways to run connectors](#two-ways-to-run-connectors) for the zero-Node container path. The steps below are for local development or embedding connectors in a Node service.

```sh
pnpm install
pnpm build

export STATEWAVE_URL=http://localhost:8000
export STATEWAVE_API_KEY=...

statewave-connectors doctor

# Preview — no ingestion happens
statewave-connectors sync github \
  --repo smaramwbc/statewave \
  --subject repo:smaramwbc/statewave \
  --dry-run

statewave-connectors sync markdown \
  --path ./docs \
  --subject repo:smaramwbc/statewave \
  --dry-run

export SLACK_BOT_TOKEN=xoxb-...
statewave-connectors sync slack \
  --channels general,support \
  --subject team:acme \
  --dry-run

export N8N_API_KEY=...
statewave-connectors sync n8n \
  --workflows "Daily ETL,42" \
  --instance-url https://n8n.example.com \
  --dry-run

# Start the MCP server (stdio JSON-RPC 2.0 transport)
statewave-connectors mcp start
```

## IDE Companion / Copilot / Cursor memory

The **Statewave IDE Companion** (VS Code / Cursor extension) makes Statewave aware of your developer workspace — project structure, documentation, git state, changed files, and diagnostics — and exposes that memory back to Copilot / Cursor through the **existing** MCP server. No IDE-specific MCP tools are added: assistants retrieve via the canonical `statewave_get_context` / `statewave_get_timeline`.

**Zero-config:** you run only your Statewave server and install the plugin. From the one `statewave.url`/`apiKey` you set, the plugin wires the MCP server itself — an in-memory server for VS Code/Copilot (key never written to disk) and a managed entry in the global `~/.cursor/mcp.json` for Cursor. No second config file, no extra container. The Statewave memory runtime becomes the always-present project brain so the assistant makes fewer mistakes.

**It does not read your private Copilot or Cursor chat history.** It observes the workspace, docs, git state, diagnostics, and explicit, user-approved events — nothing else. There is no chat interception.

- **No ingestion on install or activation.** Every command previews episodes first; sending is a separate explicit click. The file watcher only sends on save if you opt into `statewave.autoIndex` (off by default).
- **Redaction on by default**; diagnostics never carry source code; no telemetry.
- Editor-independent logic ships as [`@statewavedev/ide-core`](packages/ide-core) (fully unit-tested); the thin VS Code / Cursor host is [`packages/vscode-extension`](packages/vscode-extension).

```sh
pnpm install
pnpm --filter @statewavedev/ide-core build
pnpm --filter statewave-ide-companion build   # then press F5 in packages/vscode-extension, or build a VSIX
```

See [docs/vscode-extension.md](docs/vscode-extension.md), [docs/ide-memory.md](docs/ide-memory.md), and [examples/statewave-ide-companion](examples/statewave-ide-companion).

## Dry-run first

Every connector supports `--dry-run`. The CLI runs the read path and the mapper, prints the resulting episodes, and **does not** call the Statewave ingest API. The CLI also refuses to ingest if `STATEWAVE_URL` is unset.

That's deliberate. We never want a `git pull && pnpm install` to silently start mirroring private data to a remote service.

## Privacy & redaction

- Per-connector credentials. The GitHub connector never reads Slack tokens; the Markdown connector never makes a network call.
- Built-in best-effort redaction for emails, phone numbers, and common API-key shapes. Off by default; opt in per-sync.
- `--include` / `--exclude` filters for slicing what a connector reads.
- No telemetry. No phone-home. Source state is local.

See [docs/privacy-redaction.md](docs/privacy-redaction.md).

## Documentation

- [docs/connector-contract.md](docs/connector-contract.md) — what every connector must implement
- [docs/episode-schema.md](docs/episode-schema.md) — the single normalized episode shape
- [docs/subject-strategy.md](docs/subject-strategy.md) — how to pick subjects (the most important call you make)
- [docs/vscode-extension.md](docs/vscode-extension.md) — the VS Code / Cursor IDE Companion (commands, settings, privacy)
- [docs/ide-memory.md](docs/ide-memory.md) — how Copilot / Cursor read workspace memory back via the canonical MCP tools
- [docs/privacy-redaction.md](docs/privacy-redaction.md) — safety primitives
- [docs/contribution-guide.md](docs/contribution-guide.md) — how to add a new connector
- [docs/deployment.md](docs/deployment.md) — how to deploy the runner (Docker / Compose / Helm / Fly / Railway)
- [docs/roadmap.md](docs/roadmap.md) — what's shipping when

## Examples

- **[examples/repo-memory-quickstart](examples/repo-memory-quickstart)** — end-to-end demo: `doctor`, markdown dry-run on the included sample docs, GitHub dry-run, MCP tool listing. Runs offline.
- [examples/github-repo-memory](examples/github-repo-memory) — repo memory from a real GitHub repo
- [examples/docs-decision-memory](examples/docs-decision-memory) — decision memory from local Markdown
- [examples/copilot-mcp-memory](examples/copilot-mcp-memory) — agent memory via the MCP server
- [examples/statewave-ide-companion](examples/statewave-ide-companion) — workspace memory for Copilot / Cursor (sample config, sample episodes, MCP setup)
- [examples/slack-support-memory](examples/slack-support-memory) — team / customer support memory from Slack
- [examples/discord-community-memory](examples/discord-community-memory) — community memory from Discord
- [examples/zendesk-customer-memory](examples/zendesk-customer-memory) — customer support memory from Zendesk

## Layout

```
statewave-connectors/
├── packages/
│   ├── core/                     @statewavedev/connectors-core
│   ├── cli/                      @statewavedev/connectors-cli
│   ├── mcp-server/               @statewavedev/mcp-server
│   ├── github/                   @statewavedev/connectors-github
│   ├── markdown/                 @statewavedev/connectors-markdown
│   ├── ide-core/                 @statewavedev/ide-core                 (IDE Companion core)
│   ├── vscode-extension/         statewave-ide-companion                (VS Code / Cursor, private)
│   ├── slack/                    @statewavedev/connectors-slack         (pull + Events-API webhook)
│   ├── n8n/                      @statewavedev/connectors-n8n
│   ├── zapier/                   @statewavedev/connectors-zapier        (helper)
│   ├── discord/                  @statewavedev/connectors-discord
│   ├── zendesk/                  @statewavedev/connectors-zendesk       (pull + webhook receiver)
│   ├── intercom/                 @statewavedev/connectors-intercom      (pull + webhook receiver)
│   ├── freshdesk/                @statewavedev/connectors-freshdesk     (pull + webhook receiver)
│   ├── notion/                   @statewavedev/connectors-notion
│   ├── gmail/                    @statewavedev/connectors-gmail         (pull + Pub/Sub push)
│   └── all/                      @statewavedev/connectors               (convenience)
├── examples/
└── docs/
```

## License

Apache-2.0.
