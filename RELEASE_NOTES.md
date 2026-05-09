# Release Notes

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
