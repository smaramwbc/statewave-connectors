# Statewave IDE Companion (VS Code / Cursor)

The IDE Companion makes Statewave aware of your **developer workspace** — project structure, documentation, git state, changed files, and diagnostics — and exposes that memory back to Copilot / Cursor through the existing [MCP server](../packages/mcp-server). It is vendor-neutral: the same build runs in VS Code and in Cursor.

Two packages implement it:

- [`@statewavedev/ide-core`](../packages/ide-core) — editor-independent logic (scanning, classification, subject strategy, episode mapping, redaction, ingestion). No `vscode` import; fully unit-tested.
- `statewave-ide-companion` ([`packages/vscode-extension`](../packages/vscode-extension)) — the thin VS Code / Cursor host. Bundled with esbuild into a single CommonJS file; `vscode` is the only runtime external.

> **It does not read your Copilot / Cursor chat history.** See [Privacy](#privacy).

## Install / develop

```sh
pnpm install
pnpm --filter @statewavedev/ide-core build
pnpm --filter statewave-ide-companion build     # esbuild → packages/vscode-extension/dist/extension.cjs
```

- **Run in a dev host:** open `packages/vscode-extension` in VS Code and press `F5` ("Run Extension"). Works identically in Cursor.
- **Build a VSIX:** `pnpm --filter statewave-ide-companion package` (requires `@vscode/vsce`), then `code --install-extension statewave-ide-companion.vsix` (or `cursor --install-extension …`).

The extension's `package.json` `name` is `statewave-ide-companion` (extension id `statewavedev.statewave-ide-companion`) rather than a scoped npm name — the VS Code manifest *is* the `package.json`, and the marketplace rejects `/` in `name`. The package is `private` and never published to npm.

## Commands

| Command | Behaviour |
|---|---|
| **Statewave: Build Project Memory** | Scans + classifies the workspace, reads git context, builds the project summary, detects docs + ADR/RFC/decision files, collects diagnostics. Previews every episode in the output channel, then offers an explicit **Ingest to Statewave** action. |
| **Statewave: Sync Changed Files** | Maps the watcher's debounced saved/created/deleted files to `ide.file.changed` episodes. Preview-first, explicit ingest. |
| **Statewave: Show Project Memory Summary** | Opens the rendered project summary as a Markdown document. No network. |
| **Statewave: Configure Statewave** | Opens the `statewave.*` settings. |

## Settings

| Setting | Type | Default | Notes |
|---|---|---|---|
| `statewave.url` | string | `http://localhost:8100` | Instance base URL; defaulted so a local instance needs zero setup. Empty ⇒ preview-only. A URL alone never sends anything — ingestion still requires the explicit action. |
| `statewave.apiKey` | string | `""` | Prefer user/machine settings. Never logged; sent only to `statewave.url`. |
| `statewave.subjectStrategy` | `auto` \| `repo` \| `workspace` | `auto` | See [subject strategy](#subject-strategy). |
| `statewave.subject` | string | `""` | Explicit override; when set, used verbatim (then sanitized to the server's `subject_id` charset). |
| `statewave.autoIndex` | boolean | `false` | The only switch that lets the watcher send on save. |
| `statewave.includeGlobs` | string[] | `[]` | Force-includes (wins over the default ignore set). |
| `statewave.excludeGlobs` | string[] | `[]` | Extra excludes on top of the default ignore set. |
| `statewave.redaction.enabled` | boolean | `true` | Best-effort email/phone/API-key scrub before anything leaves the editor. |
| `statewave.compileAfterIngest` | boolean | `true` | Compile the subject into durable memory right after a successful ingest. |
| `statewave.mcp.autoWire` | boolean | `true` | Auto-wire the Statewave MCP server into the assistant (see below). |

## Zero-config MCP wiring (the project brain)

The goal: run only your Statewave server, install the plugin — and the assistant can read project memory with **no MCP file to hand-edit and no extra container**. The Statewave memory runtime becomes the always-present project brain so Copilot/Cursor make fewer mistakes. From the single `statewave.url` / `statewave.apiKey`:

- **VS Code / Copilot:** an MCP server is registered **in-memory** via the VS Code provider API (`vscode.lm.registerMcpServerDefinitionProvider`, VS Code ≥ 1.101). It runs a server bundled in the extension (`dist/mcp-stdio.cjs`) using the editor's own Node; **the API key is injected at launch, never written to disk.** Feature-detected — older VS Code falls back to manual config (logged in the output channel).
- **Cursor:** a managed `statewave` entry is merged into your **global** `~/.cursor/mcp.json` (home dir, not the repo — no secret in version control), preserving other servers, only when Cursor is installed.
- **Claude Code:** a **local-scoped** entry written to `~/.claude.json` under `projects["<abs-project-path>"].mcpServers.statewave` (home dir, never committed, no approval prompt, auto-loaded next session). Surgical merge; never clobbers `~/.claude.json`; only when that file already exists.

Both reuse the existing, tested `@statewavedev/mcp-server`; no new transport or tools. Docker MCP stays the right choice for headless/team/CI, not the individual-developer path. Turn the whole thing off with `statewave.mcp.autoWire: false`.

> First-use tips: for **Claude Code**, start a new session (or `/mcp`) after wiring. For any assistant, the first prompt should name the tool — *"call the `statewave_get_context` tool for subject `repo:owner.name`"* — because "Statewave memory" collides with assistants' built-in memory features.

## Subject strategy

The default subject for the workspace:

- `auto` → `repo:<owner>.<repo>` when a git remote parses, else `workspace:<folder-slug>`
- `repo` → always `repo:<owner>.<repo>` (errors out with guidance if there is no remote)
- `workspace` → always `workspace:<folder-slug>`
- `statewave.subject` set → that string (overrides everything)

This follows the same subject contract every connector documents (see [subject-strategy.md](./subject-strategy.md)). One deliberate deviation: the Statewave server validates `subject_id` against `^[A-Za-z0-9_.\-:]+$`, which rejects `/`. The companion sanitizes `/` → `.` (so the documented `repo:<owner>/<repo>` is ingested as `repo:<owner>.<repo>`) and collapses any other out-of-set character to `-`. This guarantees the subject is always ingestable instead of failing with a 422 the moment you click *Ingest*. It is what Copilot/Cursor query against.

## What gets scanned

`@statewavedev/ide-core` walks the workspace, skipping the default ignore set (`node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, caches, virtualenvs, …) and lockfiles, then classifies each remaining file. It specifically detects: `README.md`, `package.json`, `pnpm-workspace.yaml` / other workspace manifests, `tsconfig*.json`, `pyproject.toml` / Python manifests, `Dockerfile` / `docker-compose*`, `docs/**/*.md`, ADR / RFC / decision docs, the git remote + branch, the top-level layout, and test/config files. Symlinks are never followed; files over 1 MiB are hashed by size+mtime instead of content.

## Privacy

- **No ingestion on install or activation.** Activation only registers commands (and, if `autoIndex` is on, a watcher). Nothing is scanned or sent until you run a command.
- **Preview-first, explicit send.** Every command writes a full preview to the *Statewave IDE Companion* output channel; ingestion happens only when you press the action button. `autoIndex` (off by default, your opt-in) is the sole exception and only applies to the file watcher.
- **It never reads private Copilot/Cursor chat history.** There is no API for that here and no interception. Statewave sees the workspace, docs, git state, diagnostics, and the explicit events above — nothing else.
- **Diagnostics never carry source code.** Only the message, code, severity, and location. Messages are redacted when redaction is on.
- **Redaction** reuses the connector-core primitives (`redact`), on by default.
- **No telemetry, no phone-home, no secrets committed.** The API key lives in your local settings and is sent only to your `statewave.url`.

See also [privacy-redaction.md](./privacy-redaction.md) and [ide-memory.md](./ide-memory.md).
