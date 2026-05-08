# Release Notes

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
