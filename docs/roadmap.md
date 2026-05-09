# Roadmap

The connector ecosystem ships in waves. Each wave brings a new class of memory online or polishes an existing one. This file tracks what's shipped and what's queued; release notes for every wave live in [RELEASE_NOTES.md](../RELEASE_NOTES.md).

## ✅ Shipped

### Phase 1 — foundation (v0.1.0)

- `@statewavedev/connectors-core` — connector contract, episode schema, builder, idempotency, retry, redaction, source state, summary helpers
- `@statewavedev/connectors-cli` — `doctor`, `sync`, `replay`, `test`, `listen`, `mcp start`; per-command help; `--version`; JSON output
- `@statewavedev/mcp-server` — canonical tool definitions, `StatewaveClient` against the v1 HTTP API, input-validating `dispatchTool`, stdio JSON-RPC 2.0 transport
- `@statewavedev/connectors-github` — issues, PRs, issue + PR comments, PR reviews, releases. Nine `github.*` kinds.
- `@statewavedev/connectors-markdown` — `.md`/`.mdx` scan, frontmatter, decision/ADR/RFC detection, content-hash idempotency
- `@statewavedev/connectors` — convenience meta-package (re-exports every shipped connector)

### Phase 2 — community & workflow (v0.1.1, v0.2.0, v0.2.1, v0.3.x)

- `@statewavedev/connectors-n8n` (v0.1.1) — workflow executions, failures, per-node errors via REST. `n8n.workflow.executed`, `n8n.workflow.failed`, `n8n.node.errored`.
- `@statewavedev/connectors-zapier` (v0.1.1) — push-mode helper for the Webhooks-by-Zapier path.
- `@statewavedev/connectors-discord` (v0.2.1) — server channel + thread history pull. `discord.message.posted`, `discord.thread.replied`.
- `@statewavedev/connectors-slack` evolved through this phase:
  - v0.1.1 — pull mode (channel + thread history)
  - v0.2.0 — Events-API webhook receiver (`createSlackWebhookHandler`) + `listen slack` daemon CLI
  - v0.3.0 — webhook dispatch for reactions + pins
  - v0.3.1 — opt-in DM pull (`--include-dms`, subjects `dm:<user>`)
  - v0.3.2 — opt-in MPIM / group-DM pull (`--include-mpim`, subjects `mpim:<channel>`)

### Phase 3 — customer support (v0.4.0–v0.4.2)

- `@statewavedev/connectors-zendesk` (v0.4.0) — tickets + comments → `customer:<org_or_requester>`. API token + OAuth bearer auth.
- `@statewavedev/connectors-intercom` (v0.4.1) — conversations + replies + admin notes → `customer:<company_or_contact>`. US/EU/AU regions; bearer auth.
- `@statewavedev/connectors-freshdesk` (v0.4.2) — tickets + conversations → `customer:<company_or_requester>`. API key (Basic) auth; status-code normalization; channel-source labels.

### Phase 4 — knowledge & relationships (v0.4.3, v0.4.4)

- `@statewavedev/connectors-notion` (v0.4.3) — pages + opt-in body content → `workspace:notion` by default (operator-overridable). Bearer auth; pinned to Notion-Version 2022-06-28.
- `@statewavedev/connectors-gmail` (v0.4.4) — messages matching a required Gmail query → `relationship:<other_email>`. OAuth 2.0 refresh-token flow; MIME body extraction (text/plain → text/html → snippet).

### Tier 1 polish (v0.5.0, v0.5.1)

- v0.5.0 — Slack v0.3.2 (MPIM ingestion; see Phase 2 above)
- v0.5.1 — `0.1.1` polish across the customer-support + knowledge connectors:
  - Zendesk: `--brands` + `--statuses` allowlists
  - Intercom: `--tags` + `--teams` allowlists
  - Freshdesk: `--since` pushed server-side via native `updated_since`
  - Notion: `notion.comment.posted` episode kind, opt-in via `--include pages,comments`
  - Gmail: `--label-ids` server-side filter (typed Gmail label ids; AND semantics)

## 📌 Queued

### Tier 2 — webhook (push) receivers

Each takes its own focused arc since each adds a new always-on daemon with signature verification, dedup, and retry semantics.

- Slack DM/MPIM event dispatch over the existing webhook handler
- Zendesk webhook receiver (ticket + comment events)
- Intercom webhook receiver (conversation + part events)
- Freshdesk webhook receiver
- Gmail Pub/Sub watch (push subscription + push endpoint)

### Tier 3 — new daemon shapes

These each change the deployment surface (long-lived stateful connection vs request/response handler).

- Slack Socket Mode (alternative WebSocket transport)
- Discord Gateway (stateful WebSocket; heartbeats; sequence numbers)
- Gmail service account / domain-wide delegation (needs JWT/RS256 signing — adds a crypto dep)

### Other deferred polish (per connector)

- **Zendesk**: Incremental Tickets Export API (proper cursor primitive); macros-applied as a signal kind; side conversations
- **Intercom**: Search Conversations API; Articles + Outbound message ingestion
- **Freshdesk**: Solutions / KB articles; time entries + survey responses
- **Notion**: Database queries (treating a database as a typed row source); per-block inline comments; tables, callouts, embeds, columns, synced blocks in body rendering
- **Gmail**: History API delta sync (cursor-state design); thread-level episodes; attachment metadata extraction

## Out of scope (for now)

- Hosted "all-in-one" ingestion service — connectors are libraries plus a CLI; we do not ship a hosted SaaS
- Slack App Directory / Zapier Directory listings — both require a separate SDK + review cycle and live in their own efforts
- Channel / conversation summarization episodes — held until the LLM-architecture call lands so the cost/quality tradeoff has a documented answer

## Tracking

Workspace-wide issues and feature requests are tracked centrally on [`smaramwbc/statewave/issues`](https://github.com/smaramwbc/statewave/issues). Connector-specific bugs are welcome on this repo's own [issue tracker](https://github.com/smaramwbc/statewave-connectors/issues).
