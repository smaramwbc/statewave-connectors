# AGENTS.md — guide for contributors and coding agents

A short orientation for humans and AI coding agents (GitHub Copilot, Claude,
Cursor, …) working in **statewave-connectors** — the pnpm monorepo of source
connectors (GitHub, Markdown, Slack, …) and the
[Statewave MCP server](https://github.com/smaramwbc/statewave-docs/blob/main/connectors/mcp.md)
(`@statewavedev/mcp-server`) that feed and serve Statewave memory.

## Setup, build, test

See the [README](README.md) for canonical setup. In short:

```bash
pnpm install
pnpm -r --filter "./packages/**" run build
pnpm -r --filter "./packages/**" run test
```

Packages are released with [Changesets](https://github.com/changesets/changesets)
— add a changeset for any user-facing change.

## Conventions

- **Code style & testing:** see
  [statewave-docs/dev/conventions.md](https://github.com/smaramwbc/statewave-docs/blob/main/dev/conventions.md).
- **Each connector package versions independently** on its own cadence (see the
  package changesets); don't tie them to the server version.
- **Pick subjects deliberately** — the single most important connector decision.
  Follow the
  [subject strategy](https://github.com/smaramwbc/statewave-docs/blob/main/connectors/subject-strategy.md)
  (stable, low-cardinality identifiers; one primary subject per episode).
- **Keep claims accurate and modest** in docs and examples.

## Pull requests

Keep PRs focused, add a changeset for user-facing changes, and make sure the
build and tests pass.

## Optional: give your agent memory of this repo (with Statewave)

This repo *is* the connector + MCP tooling, and the IDE companion is built right
here in `packages/vscode-extension`. The easiest way to give your assistant a
queryable project brain is that **Statewave IDE Companion** extension for
**VS Code / Cursor** (publisher `statewavedev`) — install it from your editor's
extensions marketplace. It exposes your workspace, docs, git state, structure,
and run-commands to Copilot / Cursor / Claude over MCP and **registers the MCP
server for you** (no manual config); it just needs a Statewave server to talk to
(a one-file `docker compose up`). See the
[extension README](packages/vscode-extension/README.md).

Prefer to wire it up by hand, or use another MCP client? Run the
[Statewave MCP server](https://github.com/smaramwbc/statewave-docs/blob/main/connectors/mcp.md)
(`@statewavedev/mcp-server`) directly and query subject `repo:smaramwbc/statewave-connectors`.
