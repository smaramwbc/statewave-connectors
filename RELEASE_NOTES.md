# Release Notes

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

The Slack, Discord, Notion, Zendesk, Intercom, Freshdesk, Gmail, n8n, and Zapier connector packages remain `private:true` placeholders until each one ships a real implementation. They are not on npm.

### Intentionally not in v0.1.0

- **HTTP MCP transport.** The bundled stdio JSON-RPC 2.0 transport is enough for any MCP-compatible client. An HTTP transport ships in a follow-up release.
- **Phase 2+ connectors** (Slack, Discord, Zendesk, Intercom, Freshdesk, Notion, Gmail, n8n, Zapier).

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
