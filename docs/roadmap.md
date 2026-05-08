# Roadmap

The connector ecosystem ships in phases. Each phase brings a new class of memory online.

## Phase 1 — foundation (v0.1.0) ✅ shipped

- `@statewavedev/connectors-core` — connector contract, episode schema, builder, idempotency, retry, redaction, source state, summary helpers
- `@statewavedev/connectors-cli` — `doctor`, `sync`, `replay`, `test`, `mcp start [--list-tools]`; per-command help; `--version`; JSON output; ENOENT-aware error path
- `@statewavedev/mcp-server` — canonical tool definitions, `StatewaveClient` against the v1 HTTP API, input-validating `dispatchTool`, stdio JSON-RPC 2.0 transport
- `@statewavedev/connectors-github` — issues, PRs, issue + PR comments (split correctly), PR reviews, releases. Maps to nine `github.*` kinds.
- `@statewavedev/connectors-markdown` — `.md`/`.mdx` scan, frontmatter, decision/ADR/RFC detection, content-hash idempotency, mtime `--since`

## Phase 2 — community & team (v0.1.1) ✅ partially shipped

- `@statewavedev/connectors-slack` ✅ — channel + thread history pull; bot-token auth; required `--channels` allowlist; `slack.message.posted` and `slack.thread.replied`. Live Events-API mode, DMs, reactions, pinned, and channel summarization deferred to a follow-up.
- `@statewavedev/connectors-discord` — community memory from servers, channels, forum posts (placeholder)

## Phase 3 — customer support

- `@statewavedev/connectors-zendesk` — ticket and reply memory
- `@statewavedev/connectors-intercom` — conversation and contact-note memory
- `@statewavedev/connectors-freshdesk` — ticket and reply memory

## Phase 4 — knowledge & relationships

- `@statewavedev/connectors-notion` — pages, databases, decision docs
- `@statewavedev/connectors-gmail` — thread-level relationship memory, scoped by label/query

## Phase 5 — workflow (v0.1.1) ✅ shipped

- `@statewavedev/connectors-n8n` ✅ — workflow executions, failures, and per-node errors via the n8n REST API. `n8n.workflow.executed`, `n8n.workflow.failed`, `n8n.node.errored`.
- `@statewavedev/connectors-zapier` ✅ — push-mode helper. Zapier doesn't expose a public API for enumerating other zaps' run history, so the package ships `formatZapToEpisode()` plus integration docs for the Webhooks-by-Zapier path. The Zapier-directory custom-action app is a separate effort.

## Out of scope (for now)

- Real-time webhook receivers / long-running daemons — every shipped connector is pull-first today. A daemon contract (used by Slack live mode, n8n webhooks, etc.) is a separate design effort once we have signal from real users.
- Hosted "all-in-one" agent — connectors are libraries plus a CLI. We do not ship a hosted ingestion server.
- Slack App Directory and Zapier Directory listings — both require a different SDK and review cycle and live in separate efforts.

## Tracking

Open issues and milestones in the [statewave-connectors GitHub project](https://github.com/smaramwbc/statewave-connectors) reflect the canonical state. This file is updated when a phase ships.
