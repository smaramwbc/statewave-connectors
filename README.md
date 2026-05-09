# Statewave Connectors

[![CI](https://github.com/smaramwbc/statewave-connectors/workflows/CI/badge.svg)](https://github.com/smaramwbc/statewave-connectors/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@statewavedev/connectors-core?label=%40statewavedev%2Fconnectors-core)](https://www.npmjs.com/package/@statewavedev/connectors-core)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Feed real-world events into Statewave.

Statewave Connectors turn GitHub issues, pull requests, Slack threads, Discord questions, support tickets, docs, email, and automation events into Statewave episodes.

Your agents can then retrieve compact, relevant memory by subject — instead of stuffing raw chat history or rebuilding a custom RAG pipeline for every tool.

> 📋 **Issues & feature requests** for the entire Statewave workspace are tracked centrally on [`smaramwbc/statewave`](https://github.com/smaramwbc/statewave/issues) — including connector-specific bugs. Issues are disabled on this repo so all reports funnel to one place.

## Why

Most "agent memory" implementations are limited to live chat transcripts. Real teams have memory in many places: GitHub history, Slack threads, support tickets, ADRs, email threads, workflow runs. Statewave is open memory infrastructure that holds all of those as **episodes**, compiles them into durable memories per **subject**, and serves compact context to agents on demand.

This repository is the connector ecosystem for that.

## Modular by design

This is a monorepo for development, but each connector ships as its own published package. **You install only what you need.**

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

## Status — v0.5.1 (current release wave)

| Package | Latest | Notes |
|---|---|---|
| `@statewavedev/connectors-core` | `0.1.0` | Connector contract, episode schema, builder, idempotency, retry, redaction, source-state |
| `@statewavedev/connectors-cli` | `0.1.0` | `statewave-connectors` CLI — doctor, sync, replay, test, mcp; per-command help; JSON output |
| `@statewavedev/mcp-server` | `0.1.0` | Tool definitions, `StatewaveClient`, input-validating dispatcher, stdio JSON-RPC 2.0 transport |
| `@statewavedev/connectors-github` | `0.1.0` | Issues, PRs, issue + PR comments, PR reviews, releases. Maps to `github.*` kinds. |
| `@statewavedev/connectors-markdown` | `0.1.0` | `.md` / `.mdx` scan, frontmatter, decision/ADR/RFC detection, content-hash idempotency |
| `@statewavedev/connectors-slack` | `0.3.2` | Channel + thread history (pull) + Events-API webhook (messages, reactions, pins) + opt-in DMs (`dm:<user>`) + opt-in MPIM/group-DMs (`mpim:<channel>`). |
| `@statewavedev/connectors-n8n` | `0.1.0` | Workflow executions, failures, and per-node errors. Maps to `n8n.workflow.executed`, `n8n.workflow.failed`, `n8n.node.errored`. |
| `@statewavedev/connectors-zapier` | `0.1.0` | Push-mode helper. `formatZapToEpisode()` for users who route Zapier "Webhooks by Zapier → POST" payloads through their own server. See package README for the direct-from-Zapier (no-code) path too. |
| `@statewavedev/connectors-discord` | `0.1.0` | Server channel + thread history pull. Maps to `discord.message.posted` and `discord.thread.replied`. |
| `@statewavedev/connectors-zendesk` | `0.1.1` | Tickets + comments pull. Customer-scoped subjects (`customer:<org_or_requester_id>`). Maps to `zendesk.ticket.created`, `zendesk.ticket.solved`, `zendesk.comment.posted`, `zendesk.comment.internal_note`. API token + OAuth bearer auth. v0.1.1 added `--brands` and `--statuses` allowlists. |
| `@statewavedev/connectors-intercom` | `0.1.1` | Conversations + replies + admin notes pull. Customer-scoped subjects (`customer:<company_or_contact_id>`). Maps to `intercom.conversation.created`, `intercom.conversation.closed`, `intercom.conversation.replied`, `intercom.conversation.note_added`. US/EU/AU regions. v0.1.1 added `--tags` and `--teams` allowlists. |
| `@statewavedev/connectors-freshdesk` | `0.1.1` | Tickets + conversations pull. Customer-scoped subjects (`customer:<company_or_requester_id>`). Maps to `freshdesk.ticket.created`, `freshdesk.ticket.resolved`, `freshdesk.conversation.posted`, `freshdesk.conversation.internal_note`. API key auth. v0.1.1 pushed `--since` server-side via Freshdesk's native `updated_since` filter. |
| `@statewavedev/connectors-notion` | `0.1.1` | Pages (and optional body content) pull. Decision-memory subjects (`workspace:notion` by default; operator overrides via `--subject`). Maps to `notion.page.created`, `notion.page.updated`, and (v0.1.1) `notion.comment.posted`. Bearer token auth. |
| `@statewavedev/connectors-gmail` | `0.1.1` | Messages matching a required Gmail search query. Relationship-memory subjects (`relationship:<other_email>`). Maps to `gmail.message.received`, `gmail.message.sent`. OAuth 2.0 refresh-token auth. Body extracted from MIME tree. v0.1.1 added `--label-ids` server-side filter. |
| `@statewavedev/connectors` | `0.1.0` | Convenience meta-package — re-exports all shipped connectors. Optional. |

All v0.1 connectors plus the v0.5 polish wave have shipped. See [RELEASE_NOTES.md](RELEASE_NOTES.md) for the full release history and [docs/roadmap.md](docs/roadmap.md) for what's next.

**Capabilities today:**

- Doctor reports cli + node + platform versions and per-env-var diagnostics
- GitHub dry-run with `--include`, `--exclude`, `--since`, `--max-items`, `--json`, optional `GITHUB_TOKEN`
- Markdown dry-run with all of the above plus content-hash idempotency
- Slack dry-run with `--channels`, `--since`, `--max-items`, `--include messages,thread_replies`, optional `--resolve-users`
- n8n dry-run with `--workflows`, `--instance-url`, `--since`, `--max-items`, `--include executions,node_errors`
- MCP `StatewaveClient` against the Statewave v1 HTTP API (auth, tenant, network errors mapped to typed `ConnectorError`s)
- MCP tool dispatcher with input validation for all 5 canonical tools
- `mcp start --list-tools` prints the canonical tool surface
- HTTP MCP transport is planned; the bundled stdio transport (~120 LOC, no external deps) covers `initialize` / `tools/list` / `tools/call` / `ping` / `shutdown` for any MCP-compatible client today

See [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Quickstart

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
- [docs/privacy-redaction.md](docs/privacy-redaction.md) — safety primitives
- [docs/contribution-guide.md](docs/contribution-guide.md) — how to add a new connector
- [docs/roadmap.md](docs/roadmap.md) — what's shipping when

## Examples

- **[examples/repo-memory-quickstart](examples/repo-memory-quickstart)** — end-to-end demo: `doctor`, markdown dry-run on the included sample docs, GitHub dry-run, MCP tool listing. Runs offline.
- [examples/github-repo-memory](examples/github-repo-memory) — repo memory from a real GitHub repo
- [examples/docs-decision-memory](examples/docs-decision-memory) — decision memory from local Markdown
- [examples/copilot-mcp-memory](examples/copilot-mcp-memory) — agent memory via the MCP server
- [examples/discord-community-memory](examples/discord-community-memory) — planned
- [examples/slack-support-memory](examples/slack-support-memory) — planned
- [examples/zendesk-customer-memory](examples/zendesk-customer-memory) — planned

## Layout

```
statewave-connectors/
├── packages/
│   ├── core/                     @statewavedev/connectors-core
│   ├── cli/                      @statewavedev/connectors-cli
│   ├── mcp-server/               @statewavedev/mcp-server
│   ├── github/                   @statewavedev/connectors-github
│   ├── markdown/                 @statewavedev/connectors-markdown
│   ├── slack/                    @statewavedev/connectors-slack
│   ├── n8n/                      @statewavedev/connectors-n8n
│   ├── zapier/                   @statewavedev/connectors-zapier  (helper)
│   ├── discord/                  @statewavedev/connectors-discord
│   ├── notion/ … gmail/          placeholders for future connectors
│   └── all/                      @statewavedev/connectors (convenience)
├── examples/
└── docs/
```

## License

Apache-2.0.
