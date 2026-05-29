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

This repo *is* the connector + MCP tooling, so it's the natural place to
dogfood. Run a Statewave instance, ingest this repo via the GitHub or Markdown
connector into subject `repo:smaramwbc/statewave-connectors`, and point your
MCP client at `@statewavedev/mcp-server`. See the
[MCP server](https://github.com/smaramwbc/statewave-docs/blob/main/connectors/mcp.md)
and
[connectors quickstart](https://github.com/smaramwbc/statewave-docs/blob/main/connectors/quickstart.md)
docs.
