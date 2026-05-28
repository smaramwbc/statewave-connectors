# @statewavedev/ide-core

Editor-independent core for the **Statewave IDE Companion** — workspace scanning, project summary, file classification, subject strategy, episode mapping, redaction, and Statewave HTTP ingestion reuse.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

Nothing in this package imports `vscode`. The VS Code / Cursor extension (`@statewavedev/vscode-extension`) is a thin host that turns editor events into the shapes here. All of the interesting logic is therefore unit-testable without an extension host.

## What it produces

Canonical, `ide`-prefixed episode kinds:

| Kind | Source of truth |
|---|---|
| `ide.workspace.indexed` | a full classified scan |
| `ide.project.summary` | the durable project model (languages, toolchain, layout, conventions) |
| `ide.project.commands` | declared run-commands (`package.json` scripts, `Makefile` targets, `pyproject` script tables) — **declared surface only, never source bodies/lockfiles/env** |
| `ide.git.context` | branch + remote, parsed from `.git/` without spawning git |
| `ide.docs.detected` | digest of every documentation surface |
| `ide.architecture.detected` | one per ADR / RFC / decision doc |
| `ide.file.changed` | one per debounced save / create / delete |
| `ide.diagnostics.reported` | a digest of recurring errors/warnings — **never source code** |

## Principles

- **Content-addressable idempotency.** Identical observed state re-maps to the same `idempotency_key` (Statewave dedupes); changed state yields a new memory. No volatile timestamps in keys for state-snapshot episodes.
- **Reuse, not reinvention.** Episodes are built with `EpisodeBuilder`, redaction reuses `@statewavedev/connectors-core`, and ingestion reuses `StatewaveClient` from `@statewavedev/mcp-server`.
- **No silent ingestion.** `ingestEpisodes` honours `dryRun` before anything touches the network. No telemetry.
- **The plugin never reads chat.** It observes the workspace, docs, git state, and diagnostics. Conversational facts enter memory only when the *assistant* calls `statewave_ingest_episode` itself (driven by the opt-out read-write instruction) — never by interception.

## Status

`v0.1.0` preview. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

## License

Apache-2.0.
