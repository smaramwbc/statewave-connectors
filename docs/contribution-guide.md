# Contributing a new connector

A new connector is a new package under `packages/<source>` that depends only on `@statewave/connectors-core` and implements `StatewaveConnector`.

## 1. Create the package

```
packages/<source>/
  package.json        # name = @statewave/connectors-<source>, depends on connectors-core
  tsconfig.json       # extends ../../tsconfig.base.json
  src/
    index.ts          # exports the factory + types
    client.ts         # source HTTP/SDK client (if needed)
    mapper.ts         # pure event → episode mapping
    sync.ts           # createXConnector(config): StatewaveConnector
    types.ts          # source-shaped event types
  tests/
```

Set `"name": "@statewave/connectors-<source>"`, `"type": "module"`, `"main": "dist/index.js"`, `"types": "dist/index.d.ts"`. Mirror the existing `github` package layout exactly.

## 2. Implement the contract

See [connector-contract.md](./connector-contract.md). At minimum:

- `id`, `name`, `source` constants
- `check()` returns environment diagnostics, never ingests
- `sync()` honours `dryRun`, `since`, `maxItems`, `include`, `exclude`, `cursor`, `redaction`
- `mapEvent()` is pure and deterministic
- All errors are `ConnectorError` with a typed `code` and an actionable `hint`

Use `EpisodeBuilder` and `idempotencyKey` from core. Don't reinvent them.

## 3. Subject strategy

Pick a default subject that matches the use case (see [subject-strategy.md](./subject-strategy.md)). If unsure, look at how an agent would phrase the question — *that* is the subject.

## 4. Mapper tests

Add unit tests for `mapEvent` covering at least:

- The "happy path" event for each kind
- One edge case (deleted user, empty body, missing optional field)
- Idempotency: re-mapping the same event yields the same `idempotency_key`

Tests must be deterministic — no real network, no clocks unless mocked.

## 5. Dry-run example

Add a runnable example under `examples/<source>-<usecase>-memory/` with a `README.md` that includes a `--dry-run` invocation. Examples never assume credentials are present at clone time.

## 6. Documentation

- Add a `README.md` to your package summarizing scope, planned event kinds, auth, and subject strategy.
- Update [docs/roadmap.md](./roadmap.md) to move your connector from "planned" to "available".
- If your subject strategy adds a pattern (e.g. `release:<id>`), update [docs/subject-strategy.md](./subject-strategy.md).

## 7. CI

Your package is automatically picked up by the workspace-wide `pnpm build`, `pnpm typecheck`, and `pnpm test` commands. Make sure all three pass locally before opening a PR.

## 8. Boundaries

- Your connector must depend **only** on `@statewave/connectors-core` and packages strictly required by your source SDK.
- Your connector must **never** require credentials for any other connector.
- Your connector must **not** be loaded by `@statewave/connectors-cli` eagerly — the CLI dynamically imports connectors on demand.

## 9. Quality bar

- TypeScript strict mode (no `any` escapes from public surface)
- Clear errors with hints
- Safe defaults — dry-run, opt-in filters, no auto-discovery
- Tests don't hit live services
- README explains *what* and *why*, not just *how*
