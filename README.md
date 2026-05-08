# Statewave Connectors

Feed real-world events into Statewave.

Statewave Connectors turn GitHub issues, pull requests, Slack threads, Discord questions, support tickets, docs, email, and automation events into Statewave episodes.

Your agents can then retrieve compact, relevant memory by subject — instead of stuffing raw chat history or rebuilding a custom RAG pipeline for every tool.

## Why

Most "agent memory" implementations are limited to live chat transcripts. Real teams have memory in many places: GitHub history, Slack threads, support tickets, ADRs, email threads, workflow runs. Statewave is open memory infrastructure that holds all of those as **episodes**, compiles them into durable memories per **subject**, and serves compact context to agents on demand.

This repository is the connector ecosystem for that.

## Modular by design

This is a monorepo for development, but each connector is its own published package. **You install only what you need.**

Once published to npm:

```sh
npm install @statewavedev/connectors-github
npm install @statewavedev/connectors-markdown
npm install @statewavedev/mcp-server
```

You do not need to install Slack, Gmail, Zendesk, or Notion to use the GitHub connector. The convenience meta-package `@statewavedev/connectors` exists for the rare case where you want all official connectors at once — it is **not** required for normal usage.

> **Status: not yet on npm.** v0.1.0 ships as a verified preview — package versions, exports, `prepublishOnly` checks, and a `--provenance`-ready GitHub Actions release workflow are all in place; npm publish is gated on a maintainer adding the `NPM_TOKEN` secret and flipping the workflow's `RELEASE_DRY_RUN` flag. See [Install today](#install-today) below for ways to use the packages right now.

## Status — v0.1.0 preview

This is the **v0.1.0 preview** of the connector ecosystem. The packages are not yet published to npm; install from source. Everything below is implemented and covered by tests, but the surface is intentionally narrow — we want the contract and the dry-run experience to settle before publishing.

| Package | Status | Notes |
|---|---|---|
| `@statewavedev/connectors-core` | Preview | Connector contract, episode schema, builder, idempotency, retry, redaction, source-state |
| `@statewavedev/connectors-cli` | Preview | `statewave-connectors` CLI — doctor, sync, replay, test, mcp; per-command help; JSON output |
| `@statewavedev/mcp-server` | Preview | Tool definitions, `StatewaveClient`, input-validating dispatcher. **Stdio/HTTP transport is the next package release** — `mcp start --list-tools` reflects that boundary explicitly. |
| `@statewavedev/connectors-github` | Preview | Issues, PRs, issue + PR comments, PR reviews, releases. Maps to `github.*` kinds. |
| `@statewavedev/connectors-markdown` | Preview | `.md` / `.mdx` scan, frontmatter, decision/ADR/RFC detection, content-hash idempotency |
| `@statewavedev/connectors-slack` | Planned | Placeholder only — see Phase 2 in [docs/roadmap.md](docs/roadmap.md) |
| `@statewavedev/connectors-discord` | Planned | Placeholder only |
| `@statewavedev/connectors-zendesk` | Planned | Placeholder only |
| `@statewavedev/connectors-intercom` | Planned | Placeholder only |
| `@statewavedev/connectors-freshdesk` | Planned | Placeholder only |
| `@statewavedev/connectors-notion` | Planned | Placeholder only |
| `@statewavedev/connectors-gmail` | Planned | Placeholder only |
| `@statewavedev/connectors-n8n` | Planned | Placeholder only |
| `@statewavedev/connectors-zapier` | Planned | Placeholder only |
| `@statewavedev/connectors` | Convenience | Re-exports the Phase-1 packages. Optional. |

**What works today**

- Doctor reports cli + node + platform versions and per-env-var diagnostics
- GitHub dry-run with `--include`, `--exclude`, `--since`, `--max-items`, `--json`, optional `GITHUB_TOKEN`
- Markdown dry-run with all of the above plus content-hash idempotency
- MCP `StatewaveClient` against the Statewave v1 HTTP API (auth, tenant, network errors mapped to typed `ConnectorError`s)
- MCP tool dispatcher with input validation for all 5 canonical tools
- `mcp start --list-tools` prints the canonical tool surface — useful for clients that consume schemas before connecting

**What is intentionally not in v0.1.0**

- The Slack/Discord/Zendesk/Intercom/Freshdesk/Notion/Gmail/n8n/Zapier connectors. The packages exist as placeholders with planned scope; nothing is faked.
- An HTTP MCP transport. The bundled stdio JSON-RPC 2.0 transport is small (~120 LOC, no external deps) and covers `initialize` / `tools/list` / `tools/call` / `ping` / `shutdown` — enough for any MCP-compatible client to discover the Statewave tool surface and invoke it. An HTTP transport is the next planned addition.

See [docs/roadmap.md](docs/roadmap.md) and [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Install today

Until the packages land on npm, three working install paths exist — pick the one that matches your use case.

### Option A — clone and use the workspace CLI (development / one-machine evaluation)

```sh
git clone https://github.com/smaramwbc/statewave-connectors.git
cd statewave-connectors
pnpm install
pnpm build

# Run the CLI directly:
node packages/cli/dist/index.js doctor

# Or link it globally so `statewave-connectors` is on your PATH:
pnpm --filter @statewavedev/connectors-cli link --global
statewave-connectors --help
```

### Option B — pre-built tarballs (consume from another project, no monorepo)

```sh
git clone https://github.com/smaramwbc/statewave-connectors.git
cd statewave-connectors
pnpm install
pnpm build
pnpm pack:all          # writes tarballs/*.tgz

# In your own project:
npm install /abs/path/to/statewave-connectors/tarballs/statewave-connectors-core-0.1.0.tgz
npm install /abs/path/to/statewave-connectors/tarballs/statewave-connectors-github-0.1.0.tgz
# …and any others you need
```

The same tarballs are uploaded as a workflow artifact on every CI run, so a maintainer can also share them out-of-band.

### Option C — npm (after publish)

Once `NPM_TOKEN` is configured and the maintainers flip the release workflow out of dry-run, normal `npm install @statewavedev/connectors-*` works. Until then, options A or B are the right path.

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

# Start the MCP server (tool definitions today, transport next phase)
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
