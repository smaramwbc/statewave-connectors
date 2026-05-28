# Roadmap

The connector ecosystem ships in waves. Each wave brings a new class of memory online or polishes an existing one. This file tracks what's shipped and what's queued; release notes for every wave live in [RELEASE_NOTES.md](../RELEASE_NOTES.md).

> **State of the world:** the v0.1 connector matrix is fully shipped, plus two polish waves (v0.5.x, v0.6.0), the **Tier 2 push-receiver wave (v0.7.0–v0.11.0)**, and the **Tier 3 operator/cloud productization wave (v0.12.0–v0.17.0)** — TOML config file (multi-instance), hosted runner (`statewave-connectors run`), persistent state adapters (file / Postgres / Redis), built-in OIDC verification for Gmail Pub/Sub, auth-gated Prometheus `/metrics`, and deployment recipes (Docker / Compose / Helm / Fly / Railway). `statewave-connectors listen <connector>` is the unified push-receiver daemon; `statewave-connectors run` is the hosted runner. **v0.18.0** adds the preview **Jira** and **database** source connectors (see Phase 5 below). Long-running daemon shapes (Slack Socket Mode, Discord Gateway, Gmail service-account auth) are still queued. See [RELEASE_NOTES.md](../RELEASE_NOTES.md) for the per-wave change-log.

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

### Per-connector polish (v0.6.0)

- Zendesk `0.1.2` — Incremental Tickets Export delta sync via `--cursor` / `--use-incremental` (proper cursor primitive on `/api/v2/incremental/tickets/cursor.json`)
- Gmail `0.1.2` — History API delta sync via `--cursor`; falls back to cold-start when historyId expires (~7-day Gmail history window)
- Notion `0.1.2` — `--databases` allowlist scopes the pull to specific databases via `/v1/databases/{id}/query`

### Tier 2 — webhook / push receivers (v0.7.0–v0.11.0)

Each landed as its own focused arc — a new always-on daemon with signature verification, dedup, and retry semantics. Every connector with a meaningful push surface in its source system now has one alongside its pull connector. `statewave-connectors listen <connector>` is the unified daemon; the same `(Request) => Promise<Response>` factory mounts on Vercel / Cloudflare / Express identically across the lineup.

| Wave | Connector | Auth scheme | Episode kinds dispatched | Release |
|---|---|---|---|---|
| 2.1 | Slack DM + MPIM (extension to existing webhook handler) | HMAC-SHA256 (Events-API) | `slack.dm.message.posted`, `slack.dm.thread.replied`, `slack.mpim.message.posted`, `slack.mpim.thread.replied` | v0.7.0 (`connectors-slack@0.4.0`) |
| 2.2 | Freshdesk | Shared-secret header (`X-Statewave-Token` by default) | `freshdesk.ticket.created`, `freshdesk.ticket.resolved`, `freshdesk.conversation.posted`, `freshdesk.conversation.internal_note` | v0.8.0 (`connectors-freshdesk@0.2.0`) |
| 2.3 | Zendesk | HMAC-SHA256 + replay window (trigger and event-driven payloads) | `zendesk.ticket.created`, `zendesk.ticket.solved`, `zendesk.comment.posted`, `zendesk.comment.internal_note` | v0.9.0 (`connectors-zendesk@0.2.0`) |
| 2.4 | Intercom | HMAC-SHA1 (`X-Hub-Signature`) | `intercom.conversation.created`, `intercom.conversation.replied`, `intercom.conversation.note_added`, `intercom.conversation.closed` | v0.10.0 (`connectors-intercom@0.2.0`) |
| 2.5 | Gmail | Cloud Pub/Sub push + path-token (pluggable `verifyAuth` for OIDC) | `gmail.message.received`, `gmail.message.sent` (after walking the History API from a persistent per-mailbox cursor) | v0.11.0 (`connectors-gmail@0.2.0`) |

### Phase 5 — Jira + database source connectors (v0.18.0, preview)

- `@statewavedev/connectors-jira` (`0.1.0`) — Jira Cloud REST v3, API-token auth, pull-mode. Issues + opt-in comments → `project:<KEY>`. No-email user fields (displayName/accountId), ADF→plain-text, redaction, project allowlist. `jira.issue.created`, `jira.issue.resolved`, `jira.comment.created`.
- `@statewavedev/connectors-database` (`0.1.0`) — one package, four dialects (`postgres | mysql | mariadb | mssql`). Selected external rows → Statewave memory (**not** a Statewave storage backend; Statewave's own storage remains PostgreSQL + pgvector). Read-only, allowlisted table or operator SELECT, selected columns, required `--max-rows`, `${ENV}` secrets, no schema-wide dump, no mutation queries. `database.row`. All four dialects — PostgreSQL / MySQL / MariaDB / MSSQL — live-verified.
- `@statewavedev/connectors-cli` → `0.2.1` — wires `sync jira` + `sync database`.

## 📌 Queued

### Tier 3 — new daemon shapes

Each changes the deployment surface (long-lived stateful connection vs request/response handler).

- Slack Socket Mode (alternative WebSocket transport)
- Discord Gateway (stateful WebSocket; heartbeats; sequence numbers)
- Gmail service account / domain-wide delegation (needs JWT/RS256 signing — adds a crypto dep)

### Other deferred polish (per connector)

- **Zendesk**: macros-applied as a signal kind; side conversations
- **Intercom**: Search Conversations API; Articles + Outbound message ingestion
- **Freshdesk**: Solutions / KB articles; time entries + survey responses
- **Notion**: per-block inline comments; tables, callouts, embeds, columns, synced blocks in body rendering; typed property mapping
- **Gmail**: thread-level episodes; attachment metadata extraction; a renew-watch helper that calls `users.watch` on a schedule

## Out of scope (for now)

- Hosted "all-in-one" ingestion service — connectors are libraries plus a CLI; we do not ship a hosted SaaS
- Slack App Directory / Zapier Directory listings — both require a separate SDK + review cycle and live in their own efforts
- Channel / conversation summarization episodes — held until the LLM-architecture call lands so the cost/quality tradeoff has a documented answer

## Tracking

All issues and feature requests for the Statewave workspace — including connector-specific bugs — go to [`smaramwbc/statewave/issues`](https://github.com/smaramwbc/statewave/issues). The Issues tab is disabled on this repo so all reports funnel to one place.
