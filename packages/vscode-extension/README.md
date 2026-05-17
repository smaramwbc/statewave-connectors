# Statewave IDE Companion (VS Code / Cursor)

Makes Statewave aware of your **workspace, project structure, docs, git state, and diagnostics**, then lets Copilot / Cursor read that memory back through the existing Statewave MCP server.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem. Editor-independent logic lives in [`@statewavedev/ide-core`](../ide-core).

## The plugin never reads your Copilot/Cursor/Claude chat

There is no transcript access and no interception. On its own the extension observes only:

- the workspace file tree (classified, ignore-filtered)
- README / docs / ADR / RFC / decision documents (+ git history, code structure)
- git branch + remote (parsed from `.git/`, no `git` spawned)
- editor diagnostics (messages + locations only — **never source code**)
- files you save (only when you turn on `statewave.autoIndex`)

**Conversational facts** ("my favorite color is red") enter memory only because, with
`statewave.assistantInstructions: read-write` (default), we write a no-secret rules
file telling the **assistant** to call the public `statewave_ingest_episode` MCP tool
when *you* state a durable fact. That is the model taking a visible, approvable
action — not the plugin scraping chat. Set `read-only` (consult only) or `off`.

## Safety model

- **No ingestion on install or activation.** Activation registers commands and nothing else.
- **Preview-first.** Every command previews episodes in the *Statewave IDE Companion* output channel; sending is a separate, explicit button press.
- **`statewave.autoIndex` is off by default.** It is the only switch that lets the file watcher send anything without a button press, and you turn it on yourself.
- **Redaction on by default** (`statewave.redaction.enabled`) — email / phone / API-key shapes are scrubbed before anything leaves the editor.
- **Auto-wiring keeps secrets out of the repo.** MCP config is written only to home-dir / editor-storage files (or in-memory for Copilot); the API key never lands in version control. Agent-instruction files carry no secrets and are meant to be committed.
- **No telemetry. No phone-home.** The only network call is to your configured `statewave.url`.

## Commands

| Command | What it does |
|---|---|
| `Statewave: Build Project Memory` | Scan + classify the workspace, build the project summary, detect docs/architecture, collect diagnostics → preview, then optional ingest |
| `Statewave: Sync Changed Files` | Map debounced saved/created/deleted files → preview, then optional ingest |
| `Statewave: Show Project Memory Summary` | Open the rendered project summary (no network) |
| `Statewave: Configure Statewave` | Jump to the `statewave.*` settings |

## Settings

`statewave.url`, `statewave.apiKey`, `statewave.subjectStrategy`, `statewave.subject` (override), `statewave.autoIndex`, `statewave.includeGlobs`, `statewave.excludeGlobs`, `statewave.redaction.enabled`, `statewave.compileAfterIngest`, `statewave.mcp.autoWire`, `statewave.mcp.clients`, `statewave.assistantInstructions`. See [docs/vscode-extension.md](https://github.com/smaramwbc/statewave-connectors/blob/main/docs/vscode-extension.md).

## Develop / package

```sh
pnpm install
pnpm --filter @statewavedev/ide-core build
pnpm --filter statewave-ide-companion build      # esbuild → dist/extension.cjs
# F5 in VS Code (Run Extension) loads it in an Extension Development Host.
# Or build a VSIX:
pnpm --filter statewave-ide-companion package     # needs @vscode/vsce
```

> The package is named `statewave-ide-companion` (a marketplace-valid id `statewavedev.statewave-ide-companion`) rather than a scoped npm name, because the VS Code extension manifest *is* its `package.json` and the marketplace rejects `/` in `name`. It is `private` and never published to npm; changesets ignore it automatically.

## Status

`v0.1.0` MVP preview. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

## License

Apache-2.0.
