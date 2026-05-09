# Release Notes

## v0.4.3 — Notion connector (pull-mode)

`@statewavedev/connectors-notion` ships at `0.1.0`. First connector in the docs/decision-memory class — turns Notion pages (and optionally their body content) into normalized episodes scoped to whatever organizational unit the operator cares about (a repo, project, team, or the default `workspace:notion`).

| Surface | Detail |
|---|---|
| Episode kinds | `notion.page.created` (when `created_time === last_edited_time`), `notion.page.updated` (everything else) |
| Subject default | `workspace:notion` — operator overrides via `--subject repo:owner/name` (or any string) for retrieval-shape control, since Notion has no natural customer-axis equivalent |
| Auth | Bearer (internal integration token **or** OAuth access token — same header shape as Intercom) |
| API surface | `POST /v1/search` filtered to pages (cursor pagination by `next_cursor`), `GET /v1/blocks/{id}/children` for body extraction |
| API version pin | `Notion-Version: 2022-06-28` (long-stable) |
| CLI | `sync notion [--api-token <token>] [--subject <s>] [--include pages,content]` |
| Doctor | reports `NOTION_API_TOKEN` |
| Test wiring | `cli test --connector notion` |

**Body content is off by default.** Pass `--include pages,content` to also walk every page's child blocks via `/v1/blocks/{id}/children` and render them to plaintext (one extra API call per page, plus pagination if the page has > 100 blocks). The most common block types are rendered with markdown-style prefixes:

| Block type | Rendered as |
|---|---|
| `paragraph` | plain text |
| `heading_1` / `heading_2` / `heading_3` | `# text` / `## text` / `### text` |
| `bulleted_list_item` / `numbered_list_item` | `- text` / `1. text` |
| `to_do` | `[ ] text` or `[x] text` |
| `quote` | `> text` |
| `code` | triple-backtick fenced block with language |

Other types (callouts, embeds, tables, columns, child databases, synced blocks) are dropped at the extractor — v0.1 keeps the surface small and predictable.

The connector requires the integration to be **shared with each page or database it should read** — Notion's permission model means it cannot see anything that hasn't been explicitly connected via the page's "Connections" menu (sharing a parent shares all children).

18 new tests (10 mapper + 8 sync) covering: page-vs-update classification on equal-timestamp boundary, default + custom subject routing, optional body content extraction with all supported block types (and confirmation that callouts/etc are dropped), Bearer + Notion-Version header shape, 401 → `auth_failed` translation, and `--since` filtering on `last_edited_time`. Repo-wide test count: **256 across 14 packages**, all green.

Out of scope for v0.1.0 (queued for follow-ups):

- Database queries (treating a database as a typed row source rather than a page collection)
- Comment ingestion (`/v1/comments`)
- Property mapping into structured episode metadata (today only the title property is read; other typed columns are dropped)
- Tables, callouts, embeds, columns, synced blocks in body rendering
- Webhook (push) mode — Notion's outbound webhooks are still in private beta on API version `2022-06-28`

## v0.4.2 — Freshdesk connector (pull-mode)

`@statewavedev/connectors-freshdesk` ships at `0.1.0`. Third connector in the support-tools class — turns Freshdesk tickets and conversation entries into normalized episodes scoped to the customer (company or requester). Fully clears the public "Customer memory" promise on `/connectors`.

| Surface | Detail |
|---|---|
| Episode kinds | `freshdesk.ticket.created`, `freshdesk.ticket.resolved`, `freshdesk.conversation.posted`, `freshdesk.conversation.internal_note` |
| Subject default | `customer:<company_id>` when set, else `customer:<requester_id>` (B2C / single-tenant fallback) |
| Auth | API key via HTTP Basic auth (Freshdesk's quirk: password is literally the string `X`, with the API key in the username slot — the connector handles that for you) |
| API surface | `GET /agents/me`, `GET /tickets` (page-number pagination), `GET /tickets/{id}/conversations`, `GET /contacts/{id}` (best-effort enrichment), `GET /companies/{id}` |
| Status normalization | Numeric codes (2=Open, 3=Pending, 4=Resolved, 5=Closed, 6=Waiting on Customer, 7=Waiting on Third Party) normalized to typed strings; raw code preserved as `ticket_status_code` for routing on custom statuses |
| Channel labels | `source` integer mapped to readable labels (`email`, `portal`, `phone`, `chat`, `mobihelp`, `feedback_widget`, `outbound_email`, `ecommerce`, fallback `source:<n>`) |
| CLI | `sync freshdesk --subdomain <acme> [--api-key <key>] [--include tickets,conversations]` |
| Doctor | reports `FRESHDESK_SUBDOMAIN` + `FRESHDESK_API_KEY` |
| Test wiring | `cli test --connector freshdesk` |

**Conversations are off by default.** Pass `--include tickets,conversations` to walk every ticket's conversation thread (one extra API call per ticket — same gating as Zendesk and Intercom). Private agent notes route to a separate `freshdesk.conversation.internal_note` kind so consumers can filter on visibility without re-deriving it from metadata.

19 new tests (11 mapper + 8 sync) covering: subject routing across company/requester/ticket axes, ticket/resolved/conversation kind routing, public vs internal note discrimination, the Basic auth `<api_key>:X` shape, channel label mapping (including unknown source codes), 401 → `auth_failed` translation, and status code normalization. Repo-wide test count: **238 across 13 packages**, all green.

Out of scope for v0.1.0 (queued for follow-ups):

- The `updated_since` filter on `GET /tickets` (the right primitive for ongoing high-volume sync)
- Solutions / KB articles ingestion
- Time entries + survey responses
- Webhook (push) mode

## v0.4.1 — Intercom connector (pull-mode)

`@statewavedev/connectors-intercom` ships at `0.1.0`. Second connector in the support-tools class — turns Intercom conversations and conversation-parts into normalized episodes scoped to the customer (primary company or contact). Closes the second half of the public "Customer memory" promise on `/connectors`.

| Surface | Detail |
|---|---|
| Episode kinds | `intercom.conversation.created`, `intercom.conversation.closed`, `intercom.conversation.replied`, `intercom.conversation.note_added` |
| Subject default | `customer:<primary_company_id>` (first company on the contact) when set, else `customer:<contact_id>` |
| Auth | Bearer (personal access token **or** OAuth access token — same header shape) |
| Regions | US (default), EU, AU — picks the right `api.<region>.intercom.io` edge so EU/AU operators don't accidentally hit US infra |
| API surface | `GET /me`, `GET /conversations` (cursor pagination), `GET /conversations/{id}?display_as=plaintext`, `GET /contacts/{id}`, `GET /companies/{id}` (best-effort enrichment) |
| API version pin | `Intercom-Version: 2.13` |
| CLI | `sync intercom [--region us\|eu\|au] [--app-id <id>] [--include conversations,parts]` |
| Doctor | reports `INTERCOM_ACCESS_TOKEN` (with region) |
| Test wiring | `cli test --connector intercom` |

**Conversation parts are off by default.** Pass `--include conversations,parts` to also walk every conversation's part stream (one extra API call per conversation). System parts (assignment, close, snooze, away_mode, …) are dropped at the mapper — only "comment" (replies) and "note" (admin internal notes) become episodes. Notes route to a separate `intercom.conversation.note_added` kind so consumers can filter on visibility without re-deriving it from metadata.

19 new tests (10 mapper + 9 sync) covering: subject routing across primary-company / contact / conversation axes, conversation/closed/reply/note kind routing, public vs internal note discrimination, the Bearer + Intercom-Version header shape, regional routing (`api.eu.intercom.io`), and 401 → `auth_failed` translation. Repo-wide test count: **219 across 12 packages**, all green.

Out of scope for v0.1.0 (queued for follow-ups):

- The Search Conversations API for richer server-side filtering
- Tag/team allowlist (`--tags`, `--teams`)
- Articles + Outbound message ingestion
- Webhook (push) mode — same daemon shape as Slack live-mode

## v0.4.0 — Zendesk connector (pull-mode)

`@statewavedev/connectors-zendesk` ships at `0.1.0`. First connector in the support-tools class — turns Zendesk tickets and comments into normalized episodes scoped to the customer (organization or requester) so support-agent workflows have per-account memory of what's broken, what's already been said, and what's still open.

| Surface | Detail |
|---|---|
| Episode kinds | `zendesk.ticket.created`, `zendesk.ticket.solved`, `zendesk.comment.posted`, `zendesk.comment.internal_note` |
| Subject default | `customer:<organization_id>` when set, else `customer:<requester_id>` (B2C / single-tenant fallback) |
| Auth | API token (Basic) **or** OAuth bearer — auto-detected from env / CLI flags. The connector never runs the OAuth dance; operators bring their own access token. |
| API surface | `GET /users/me`, `GET /tickets.json` (cursor pagination), `GET /tickets/{id}/comments.json`, `GET /organizations/show_many.json` (best-effort enrichment) |
| CLI | `sync zendesk --subdomain <acme> [--include tickets,comments]` |
| Doctor | reports `ZENDESK_SUBDOMAIN` + `ZENDESK_AUTH` (oauth bearer takes precedence over api_token) |
| Test wiring | `cli test --connector zendesk` |

**Comments are off by default.** Pass `--include tickets,comments` to also walk every ticket's comment thread (one extra API call per ticket — gated to keep the per-sync API budget bounded). Public comments map to `zendesk.comment.posted`; internal notes map to a separate `zendesk.comment.internal_note` kind so consumers can route on visibility without re-deriving it from metadata.

19 new tests (10 mapper + 9 sync) covering: subject routing across both org/requester axes, ticket/solved/comment kind routing, public vs internal note discrimination, both auth header shapes, and 401 → `auth_failed` translation. Repo-wide test count: **200 across 11 packages**, all green.

Out of scope for v0.1.0 (queued for follow-ups):

- Incremental Tickets Export API (the right primitive for high-volume ongoing sync)
- Macros applied as a signal episode kind
- Side conversations
- Brand allowlist (`--brands`)
- Per-author identity enrichment beyond the requester (saves N+1 lookups)

## v0.3.1 — Slack DM ingestion (pull)

`@statewavedev/connectors-slack` bumps to `0.3.1`. Adds opt-in DM ingestion to the pull-mode connector — the bot's DM history with each human counterparty becomes its own per-user subject so DM and channel signals can flow through a single sync without colliding.

| New surface | Detail |
|---|---|
| `--include-dms` flag | Pulls every DM conversation the bot user is a participant in. Combinable with `--channels` for a single mixed sync. |
| Subject routing | `dm:<other_user_id>` per DM (vs `team:<team_id>` for channels). Operators can still pass `--subject` to override. |
| New episode kinds | `slack.dm.message.posted`, `slack.dm.thread.replied` |
| New scopes | `im:read` (discover DM conversations), `im:history` (read messages) |
| Sync details | New `events_dms` and `dms_synced` counters in the per-run summary |

DMs route under per-user subjects on purpose — co-mingling a human's DMs with public channel chatter on `team:<team_id>` would surprise anyone routing on subject for retrieval. The `dm:<other_user_id>` shape mirrors how a support agent thinks about "the conversation I'm having with this person."

5 new tests in `packages/slack/tests/sync-dms.test.ts` cover: rejection when neither `--channels` nor `--include-dms` is set, accept-with-DMs-only, DM ingestion with correct subject + kind routing, mixed channels-and-DMs in a single sync, and DM thread-reply routing to `slack.dm.thread.replied`. Repo-wide tests: **181 across 10 packages**, all green.

**Bot tokens can only see DMs the bot is itself a participant in** — i.e. between a human and the bot user, not between two humans. This is a Slack platform constraint, not a connector limitation. Documented in the package README.

Out of scope for v0.3.1 (queued for later):

- DMs over the Events API webhook (currently pull-only — webhook DM dispatch lands in a follow-up)
- Multi-party DM (`mpim`) channels
- Socket Mode + channel summarization (still deferred per v0.2 plan)

## v0.3.0 — Slack reactions + pins (webhook)

`@statewavedev/connectors-slack` bumps to `0.3.0`. The webhook handler from v0.2 grows two new dispatch paths so the same `(Request) => Promise<Response>` you mount on Vercel / Cloudflare / Express also turns Slack reaction + pin events into episodes.

| New episode kind | Source |
|---|---|
| `slack.reaction.added` | Slack `reaction_added` webhook event |
| `slack.reaction.removed` | Slack `reaction_removed` webhook event |
| `slack.pin.added` | Slack `pin_added` webhook event |
| `slack.pin.removed` | Slack `pin_removed` webhook event |

Pin events inline the pinned message body (Slack carries it under `item.message`); reaction events reference the parent by `channel:ts` without re-fetching the body — re-deriving message text per reaction would multiply the per-event API budget.

Channel allowlist applies to all four kinds (filter on `event.item.channel` for reactions, `event.channel_id` for pins). Same dedup-by-`event_id` retry handling as v0.2.

13 new tests bring the slack package to **52 across 6 test files**, repo-wide to **176 across 10 packages**, all green in CI.

Slack app setup additions: subscribe to `reaction_added`, `reaction_removed`, `pin_added`, `pin_removed` (needs the `reactions:read` and `pins:read` scopes). Same signing-secret + URL-verification + retry semantics as v0.2.

Out of scope for v0.3.0 (queued for v0.3.1+):

- Direct messages (privacy + opt-in framing earns its own PR)
- Pull-mode reactions / pinned (would inflate per-channel API budget; webhook is the right place for these signals)
- Socket Mode + channel summarization (still deferred per v0.2 plan)

## v0.2.1 — Discord connector (Phase-2 complete)

`@statewavedev/connectors-discord` ships at `0.1.0` — pull-mode source connector for Discord guilds, mirroring the `@statewavedev/connectors-slack@0.1.0` shape.

| Surface | Detail |
|---|---|
| Episode kinds | `discord.message.posted`, `discord.thread.replied` |
| Auth | Bot token (`DISCORD_BOT_TOKEN`); user tokens are explicitly disallowed by Discord's TOS |
| Subject default | `community:<guild_id>` (Discord snowflake — stable across guild renames) |
| API surface | `GET /users/@me`, `GET /guilds/{id}`, `GET /guilds/{id}/channels`, `GET /channels/{id}/messages` (paginated by snowflake `before=` cursor) |
| CLI | `sync discord --guild <id> --channels <ids-or-names>` |
| Doctor | reports `DISCORD_BOT_TOKEN` |
| Test wiring | `cli test --connector discord` |

16 new unit tests (8 mapper + 8 sync) covering top-level vs thread routing, custom subject overrides, author label fallback, system-message + empty-content filtering, channel-not-found errors, and 401 handling. Repo-wide test count: **163 across 10 packages**, all green.

This closes the last Phase-2 placeholder. Realtime ingestion via Discord's Gateway WebSocket protocol (the equivalent of Slack's Socket Mode) is intentionally deferred — same daemon-shape question as Slack live-mode, will land alongside the next push-mode work.

## v0.2.0 — Slack live mode + CI hardening

`@statewavedev/connectors-slack` ships its first push-mode surface — a fetch-style Events-API webhook handler plus a CLI command (`statewave-connectors listen slack`) that wraps it in a Node http daemon for the impatient.

### What ships in `@statewavedev/connectors-slack@0.2.0`

| Surface | Detail |
|---|---|
| `createSlackWebhookHandler(config)` | Pure `(Request) => Promise<Response>`. Verifies HMAC signatures (timing-safe, with replay-window), echoes `url_verification` challenge, dedups Slack retries by `event_id`, applies the channel allowlist + the same subtype filter as the pull-mode connector, maps to the same `slack.message.posted` / `slack.thread.replied` episode shapes, and ingests via a built-in default ingest function (or a caller-supplied `StatewaveIngest`). |
| `InMemoryDedupCache` | Single-process FIFO cache, ~10k entries by default. Pluggable `SlackDedupCache` interface for Redis / Postgres / shared-memory backends. |
| `verifySlackSignature` / `computeSignature` | Helper exports for callers who want to integrate the verification step somewhere outside the bundled handler. |
| `statewave-connectors listen slack` | New CLI command. Wraps the handler in Node's `http` module (no Express dep), takes `--channels`, `--port`, `--host`, `--path`, `--signing-secret`. |
| Documentation | Package README adds deploy snippets for Vercel, Cloudflare Workers, Express, plus the daemon CLI. Cross-process dedup pattern documented. |

23 new tests (signature verification, dedup eviction, full-flow webhook scenarios). Repo-wide test count is now 147 across 9 packages.

### Out of scope for v0.2 (deferred to v0.3+)

- Socket Mode (alternative WebSocket transport for the same logical layer)
- Direct messages (opt-in per workspace)
- Reactions and pinned messages as signal episodes
- Channel summarization episodes (held until LLM-architecture call lands)

### CI hardening (no version bump)

- `@statewavedev/connectors` meta-package now has real tests asserting every Phase-1 + Phase-2 factory is re-exported (instead of an `echo` test script).
- CI smoke loop exercises every available connector via `cli test --connector {github,markdown,slack,n8n,zapier,mcp}` on every push and PR.
- Sandbox tarball install now resolves all six shipped tarballs (core, github, markdown, slack, n8n, zapier, mcp-server) into a fresh project and asserts each expected named export imports cleanly. Catches publish-time `package.json#exports` regressions that vitest can't see.

## v0.1.1 — Phase-2 connectors

Three new packages ship at `0.1.0`, all published to npm with provenance:

| Package | Shape | Episode kinds |
|---|---|---|
| `@statewavedev/connectors-slack` | Pull-mode source — channel + thread history via the Slack Web API | `slack.message.posted`, `slack.thread.replied` |
| `@statewavedev/connectors-n8n` | Pull-mode source — workflow executions via the n8n REST API | `n8n.workflow.executed`, `n8n.workflow.failed`, `n8n.node.errored` |
| `@statewavedev/connectors-zapier` | Push-mode helper — `formatZapToEpisode()` for Webhooks-by-Zapier payloads | `zapier.zap.executed`, `zapier.zap.failed` |

The Zapier package is a helper rather than a sync connector because Zapier deliberately doesn't expose a public API for enumerating other zaps' run history. The package README documents two integration paths: a no-code "POST straight to `/v1/episodes/batch`" route, and a server-side route that uses the helper to massage payloads first.

CLI updates:

- `sync slack --channels …`, `sync n8n --workflows … --instance-url …`
- `doctor` reports `SLACK_BOT_TOKEN`, `N8N_API_KEY`, `N8N_INSTANCE_URL`
- `test --connector {slack,n8n,zapier}`
- `sync` help lists Zapier under a new "helpers (no sync — push-mode integrations)" section

Slack v0.1 is intentionally pull-mode-only. Live Events-API webhook mode, Socket Mode, DMs (opt-in), reactions, pinned messages, and channel summarization are deferred — each lands in a follow-up release once the connector contract grows a long-running-daemon shape.

The Slack, n8n, and Zapier directory listings (Slack App Directory / Zapier directory) are also deferred — each requires a different SDK and review cycle and will live in separate efforts.

## v0.1.0

The first release of the Statewave Connectors monorepo.

### What ships

| Surface | Detail |
|---|---|
| Connector contract | `StatewaveConnector`, `SyncOptions`, `SyncResult` (with `summary: { total, kinds, details }` for analytics) |
| Episode shape | `StatewaveEpisode` — subject, kind, text, occurred_at, source, metadata, idempotency_key |
| Builder + helpers | `EpisodeBuilder`, `idempotencyKey`, `withRetry`, `redact`, `summarizeEpisodes`, `MemorySourceStateStore`, `FileSourceStateStore` |
| GitHub | issues, PRs, issue + PR comments (split by `html_url`), PR reviews, releases |
| Markdown | `.md`/`.mdx`, frontmatter parsing, decision/ADR/RFC detection, path + content-hash idempotency, mtime-based `--since` |
| CLI | `doctor`, `sync github\|markdown`, `replay`, `test`, `mcp start [--list-tools]`; per-command help; `--version`; ENOENT-aware error path |
| MCP server | `STATEWAVE_MCP_TOOLS`, `StatewaveClient`, `dispatchTool`, minimal stdio JSON-RPC 2.0 transport (`runStdioServer`, `startStdioServerFromEnv`), bin entry `statewave-mcp-server` with `--list-tools` / `--help` / `--version`, plus `mcp start [--list-tools]` from the connectors CLI |
| Examples | `repo-memory-quickstart` (offline-friendly, end-to-end), plus per-source READMEs |
| Docs | `connector-contract`, `episode-schema`, `subject-strategy`, `privacy-redaction`, `contribution-guide`, `roadmap` |
| CI | install → build → typecheck → test on every push and PR |

### Published packages

| Package | Notes |
|---|---|
| `@statewavedev/connectors-core` | Connector contract + utilities |
| `@statewavedev/connectors-cli` | `statewave-connectors` CLI |
| `@statewavedev/mcp-server` | MCP server (stdio transport) + `StatewaveClient` |
| `@statewavedev/connectors-github` | GitHub connector |
| `@statewavedev/connectors-markdown` | Markdown / docs connector |
| `@statewavedev/connectors` | Convenience meta-package |

All published with npm provenance attestations.

The Discord, Notion, Zendesk, Intercom, Freshdesk, and Gmail connector packages remain `private:true` placeholders until each one ships a real implementation. They are not on npm. (Slack, n8n, and Zapier shipped in v0.1.1 — see above.)

### Intentionally not in v0.1.0

- **HTTP MCP transport.** The bundled stdio JSON-RPC 2.0 transport is enough for any MCP-compatible client. An HTTP transport ships in a follow-up release.
- **Phase 2+ connectors** (Discord, Zendesk, Intercom, Freshdesk, Notion, Gmail). Slack, n8n, and Zapier landed in v0.1.1.

### Known limitations

- The `replay` command is a thin wrapper over `sync --dry-run`; it does not yet persist or compare cursors.
- The MCP `StatewaveClient` targets the Statewave v1 paths (`/v1/episodes`, `/v1/memories/search`, `/v1/context`, `/v1/timeline`, `/v1/memories/compile`). If your Statewave instance exposes different paths, wrap the client.
- Best-effort secret redaction covers common token shapes (GitHub PATs, OpenAI/Anthropic keys, AWS access keys, Slack tokens, JWTs, PEM blocks) but is **not** a substitute for proper data handling. Always review dry-run output before ingesting.
- Tests run fully offline by stubbing `fetch`; CI is not gated on real GitHub or Statewave connectivity.

### Contributing

See [docs/contribution-guide.md](docs/contribution-guide.md). New connectors must:

- depend only on `@statewavedev/connectors-core`
- implement the `StatewaveConnector` contract
- ship deterministic mapper tests
- include a dry-run example
- never require credentials for any other connector
