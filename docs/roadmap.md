# Roadmap

The connector ecosystem ships in phases. Each phase brings a new class of memory online.

## Phase 1 — foundation (v0.1.0 preview)

- `@statewave/connectors-core` — connector contract, episode schema, builder, idempotency, retry, redaction, source state, summary helpers
- `@statewave/connectors-cli` — `doctor`, `sync`, `replay`, `test`, `mcp start [--list-tools]`; per-command help; `--version`; JSON output; ENOENT-aware error path
- `@statewave/mcp-server` — canonical tool definitions, `StatewaveClient` against the v1 HTTP API, input-validating `dispatchTool`. Stdio/HTTP transport is the next package release; `mcp start --list-tools` reflects that boundary explicitly.
- `@statewave/connectors-github` — issues, PRs, issue + PR comments (split correctly), PR reviews, releases. Maps to nine `github.*` kinds.
- `@statewave/connectors-markdown` — `.md`/`.mdx` scan, frontmatter, decision/ADR/RFC detection, content-hash idempotency, mtime `--since`

## Phase 2 — community & team

- `@statewave/connectors-discord` — community memory from servers, channels, forum posts
- `@statewave/connectors-slack` — team and shared-channel memory

## Phase 3 — customer support

- `@statewave/connectors-zendesk` — ticket and reply memory
- `@statewave/connectors-intercom` — conversation and contact-note memory
- `@statewave/connectors-freshdesk` — ticket and reply memory

## Phase 4 — knowledge & relationships

- `@statewave/connectors-notion` — pages, databases, decision docs
- `@statewave/connectors-gmail` — thread-level relationship memory, scoped by label/query

## Phase 5 — workflow

- `@statewave/connectors-n8n` — workflow run memory
- `@statewave/connectors-zapier` — zap run memory

## Out of scope (for now)

- Real-time webhook receivers — connectors are pull-first today; webhook ingestion will be a separate package once the contract has stabilized.
- Hosted "all-in-one" agent — connectors are libraries plus a CLI. We do not ship a hosted ingestion server.

## Tracking

Open issues and milestones in the [statewave-connectors GitHub project](https://github.com/smaramwbc/statewave-connectors) reflect the canonical state. This file is updated when a phase ships.
