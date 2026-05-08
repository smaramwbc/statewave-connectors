# Release Notes

## v0.1.0 — preview (unreleased)

The first public preview of the Statewave Connectors monorepo.

### What this preview is

A focused, dry-run-first surface that:

- defines the connector contract (`@statewave/connectors-core`)
- provides a working CLI (`@statewave/connectors-cli`) with per-command help, env diagnostics, and JSON output
- ships two real connectors — **GitHub** and **Markdown** — with stable idempotency keys, rich filtering, kind histograms in dry-run output, and end-to-end tests
- ships the MCP tool surface (`@statewave/mcp-server`) plus a real `StatewaveClient` against the Statewave v1 HTTP API, an input-validating dispatcher, and a minimal stdio JSON-RPC 2.0 transport (`initialize` / `tools/list` / `tools/call` / `ping` / `shutdown`)
- documents and scaffolds nine future connectors (Slack, Discord, Zendesk, Intercom, Freshdesk, Notion, Gmail, n8n, Zapier) as placeholder packages with planned scope only
- ships publish-prep hardening: aligned `0.1.0` versions across all real packages, `workspace:^` internal deps, `publishConfig.{access:public,provenance:true}`, `prepublishOnly` build+typecheck, Changesets for version/release management, a provenance-ready GitHub Actions release workflow that today runs in **dry-run** mode (`pnpm pack` + artifact upload) and flips to real publish once `NPM_TOKEN` is set

### What's included

| Surface | Detail |
|---|---|
| Connector contract | `StatewaveConnector`, `SyncOptions`, `SyncResult` (now with a stable `summary: { total, kinds, details }` for analytics) |
| Episode shape | `StatewaveEpisode` — subject, kind, text, occurred_at, source, metadata, idempotency_key |
| Builder + helpers | `EpisodeBuilder`, `idempotencyKey`, `withRetry`, `redact`, `summarizeEpisodes`, `MemorySourceStateStore`, `FileSourceStateStore` |
| GitHub | issues, PRs, issue + PR comments (split by `html_url`), PR reviews, releases |
| Markdown | `.md`/`.mdx`, frontmatter parsing, decision/ADR/RFC detection, path + content-hash idempotency, mtime-based `--since` |
| CLI | `doctor`, `sync github\|markdown`, `replay`, `test`, `mcp start [--list-tools]`; per-command help; `--version`; ENOENT-aware error path |
| MCP server | `STATEWAVE_MCP_TOOLS`, `StatewaveClient`, `dispatchTool`, minimal stdio JSON-RPC 2.0 transport (`runStdioServer`, `startStdioServerFromEnv`), bin entry `statewave-mcp-server` with `--list-tools` / `--help` / `--version`, plus `mcp start [--list-tools]` from the connectors CLI |
| Publish prep | Changesets config (linked Phase-1 packages, ignored placeholders), aligned `0.1.0` in each `package.json`, `workspace:^` internal deps, `publishConfig.{access:public,provenance:true}`, `prepublishOnly` runs build + typecheck, per-package README + LICENSE, `pnpm pack:all` script |
| Release workflow | `.github/workflows/release.yml` — install → build → lint → typecheck → test → pack → upload tarball artifacts. Real publish gated behind `NPM_TOKEN` + `RELEASE_DRY_RUN=false`. |
| Examples | `repo-memory-quickstart` (offline-friendly, end-to-end), plus pre-existing source-specific READMEs |
| Docs | `connector-contract`, `episode-schema`, `subject-strategy`, `privacy-redaction`, `contribution-guide`, `roadmap` |
| CI | install → build → typecheck → test on every push and PR |

### What's intentionally not in v0.1.0

- **HTTP MCP transport.** The bundled stdio JSON-RPC 2.0 transport is enough for any MCP-compatible client. An HTTP transport ships in a follow-up release.
- **Slack, Discord, Notion, Zendesk, Intercom, Freshdesk, Gmail, n8n, Zapier connectors.** Placeholder packages exist with planned scope and event kinds — no fake implementations.
- **The actual `npm publish` step.** All publish surface is verified: every package has the right manifest, `prepublishOnly` runs build+typecheck, and the release workflow successfully `pnpm pack`s and uploads tarballs as CI artifacts. Flipping to real publish needs (a) an `NPM_TOKEN` repo secret with publish rights to `@statewave`, and (b) flipping `RELEASE_DRY_RUN` to `false` (workflow_dispatch input or repo variable).

### Known limitations

- The `replay` command is a thin wrapper over `sync --dry-run`; it does not yet persist or compare cursors.
- The MCP `StatewaveClient` targets the Statewave v1 paths (`/v1/episodes`, `/v1/memories/search`, `/v1/context`, `/v1/timeline`, `/v1/memories/compile`). If your Statewave instance exposes different paths, override `pathOverrides` in a future release or wrap the client.
- Best-effort secret redaction covers common token shapes (GitHub PATs, OpenAI/Anthropic keys, AWS access keys, Slack tokens, JWTs, PEM blocks) but is **not** a substitute for proper data handling. Always review dry-run output before ingesting.
- Tests run fully offline by stubbing `fetch`; we do not gate CI on real GitHub or Statewave connectivity.

### Upgrade / publishing notes

- All real packages are at `0.1.0` and use `workspace:^` for internal deps. Changesets rewrites those to the published version on publish.
- Maintainers publish a release by:
  1. Adding an `NPM_TOKEN` repo secret with publish rights to the `@statewave` scope.
  2. Setting `RELEASE_DRY_RUN=false` (either as a repo variable or via `workflow_dispatch` input).
  3. Triggering the **Release** workflow on `main`. Changesets will open a version PR; merging that PR triggers `npm publish --provenance` per package.
- Until then, `Install today → Option B (pre-built tarballs)` in the README is the supported path.
- The convenience meta-package `@statewave/connectors` is **optional**. Install only the connectors you need.

### Contributing

See [docs/contribution-guide.md](docs/contribution-guide.md). New connectors must:

- depend only on `@statewave/connectors-core`
- implement the `StatewaveConnector` contract
- ship deterministic mapper tests
- include a dry-run example
- never require credentials for any other connector
