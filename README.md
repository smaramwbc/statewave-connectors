# Statewave Connectors

Feed real-world events into Statewave.

Statewave Connectors turn GitHub issues, pull requests, Slack threads, Discord questions, support tickets, docs, email, and automation events into Statewave episodes.

Your agents can then retrieve compact, relevant memory by subject — instead of stuffing raw chat history or rebuilding a custom RAG pipeline for every tool.

## Why

Most "agent memory" implementations are limited to live chat transcripts. Real teams have memory in many places: GitHub history, Slack threads, support tickets, ADRs, email threads, workflow runs. Statewave is open memory infrastructure that holds all of those as **episodes**, compiles them into durable memories per **subject**, and serves compact context to agents on demand.

This repository is the connector ecosystem for that.

## Modular by design

This is a monorepo for development, but each connector ships as its own published package. **You install only what you need.**

```sh
npm install @statewavedev/connectors-github
npm install @statewavedev/connectors-markdown
npm install @statewavedev/mcp-server
```

You do not need to install Slack, Gmail, Zendesk, or Notion to use the GitHub connector. The convenience meta-package `@statewavedev/connectors` exists for the rare case where you want all official connectors at once — it is **not** required for normal usage.

## Status — v0.1.0

| Package | Notes |
|---|---|
| `@statewavedev/connectors-core` | Connector contract, episode schema, builder, idempotency, retry, redaction, source-state |
| `@statewavedev/connectors-cli` | `statewave-connectors` CLI — doctor, sync, replay, test, mcp; per-command help; JSON output |
| `@statewavedev/mcp-server` | Tool definitions, `StatewaveClient`, input-validating dispatcher, stdio JSON-RPC 2.0 transport |
| `@statewavedev/connectors-github` | Issues, PRs, issue + PR comments, PR reviews, releases. Maps to `github.*` kinds. |
| `@statewavedev/connectors-markdown` | `.md` / `.mdx` scan, frontmatter, decision/ADR/RFC detection, content-hash idempotency |
| `@statewavedev/connectors` | Convenience meta-package — re-exports the Phase-1 connectors. Optional. |

**Planned (not yet implemented):** `@statewavedev/connectors-slack`, `-discord`, `-zendesk`, `-intercom`, `-freshdesk`, `-notion`, `-gmail`, `-n8n`, `-zapier`. These remain `private:true` until each one ships real code — see [docs/roadmap.md](docs/roadmap.md).

**Capabilities today:**

- Doctor reports cli + node + platform versions and per-env-var diagnostics
- GitHub dry-run with `--include`, `--exclude`, `--since`, `--max-items`, `--json`, optional `GITHUB_TOKEN`
- Markdown dry-run with all of the above plus content-hash idempotency
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
│   ├── slack/ … zapier/          placeholders for future connectors
│   └── all/                      @statewavedev/connectors (convenience)
├── examples/
└── docs/
```

## License

Apache-2.0.
