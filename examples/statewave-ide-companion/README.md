# Example — IDE Companion (workspace memory for Copilot / Cursor)

This example shows the full loop:

1. The **Statewave IDE Companion** extension observes your workspace, docs, git state, and diagnostics.
2. It maps them to Statewave episodes (preview-first; you press a button to ingest).
3. Statewave compiles them into memory for the workspace's **subject**.
4. **Copilot / Cursor** read that memory back through the **existing** Statewave MCP server — no new MCP tools.

## What this is NOT

It does **not** read your Copilot or Cursor chat history. There is no interception of assistant conversations. Statewave only sees the workspace, docs, git context, diagnostics, and the explicit, user-approved events the extension produces.

## 1. Configure the extension

Copy [`vscode-settings.sample.json`](vscode-settings.sample.json) into your project's `.vscode/settings.json` (or set the same keys in user settings). Note:

- `statewave.autoIndex` is `false` — nothing is ever sent without you pressing a button.
- `statewave.redaction.enabled` is `true` — emails / phones / API-key shapes are scrubbed.
- Put `statewave.apiKey` in **user/machine settings**, not committed workspace settings.

## 2. Build project memory (preview, then ingest)

Command Palette → **Statewave: Build Project Memory**. The *Statewave IDE Companion* output channel shows exactly what would be sent. Press **Ingest to Statewave** to actually send it. Sample output episodes are in [`sample-episodes/`](sample-episodes/) — one per kind:

| File | Kind |
|---|---|
| [`ide.workspace.indexed.json`](sample-episodes/ide.workspace.indexed.json) | `ide.workspace.indexed` |
| [`ide.project.summary.json`](sample-episodes/ide.project.summary.json) | `ide.project.summary` |
| [`ide.git.context.json`](sample-episodes/ide.git.context.json) | `ide.git.context` |
| [`ide.docs.detected.json`](sample-episodes/ide.docs.detected.json) | `ide.docs.detected` |
| [`ide.architecture.detected.json`](sample-episodes/ide.architecture.detected.json) | `ide.architecture.detected` |
| [`ide.file.changed.json`](sample-episodes/ide.file.changed.json) | `ide.file.changed` |
| [`ide.diagnostics.reported.json`](sample-episodes/ide.diagnostics.reported.json) | `ide.diagnostics.reported` |

## 3. Copilot / Cursor are wired automatically

You do **not** copy any MCP config. With `statewave.mcp.autoWire` on (the default), the plugin makes the Statewave memory runtime available to the assistant from the same `statewave.url` you already set — it is the always-present project brain:

- **Copilot** (in-memory; key never written to disk), **Cursor**, **Windsurf**, **Claude Code**, **Cline**, **Roo Code**, **Continue** — each via that client's own config, only when it's installed, secrets never in the repo. A one-time notice lists exactly which were wired. Scope it with `statewave.mcp.clients`.
- **Claude Code:** start a new session (or `/mcp`) to load it. **Continue:** if `~/.continue/config.yaml` already exists the extension logs a snippet to paste (it won't rewrite your config).
- First prompt to any assistant: ask it to **call the `statewave_get_context` tool** for `repo:<owner>.<name>` — say "tool", not "memory" (which collides with assistants' own memory features).

The retrieval side reuses the **canonical** Statewave MCP tools — no IDE-specific tools were added.

> The [`mcp/`](mcp/) JSON files in this example are only a **manual fallback** for other MCP clients or VS Code older than 1.101. For unpublished local development they should point at the built server — `node <repo>/packages/mcp-server/dist/cli.js` with `STATEWAVE_URL` / `STATEWAVE_API_KEY` in the env — not `npx @statewavedev/mcp-server` (not published).

Then ask the assistant something it could only know from workspace memory:

> "What are this repo's conventions and what changed recently?"

The assistant calls `statewave_get_context` with the workspace subject (e.g. `repo:smaramwbc.statewave-connectors` — `/` is sanitized to `.` for the server) for the project summary / conventions / docs, and `statewave_get_timeline` filtered by `ide.file.changed` / `ide.architecture.detected` / `ide.diagnostics.reported` for recent activity. The full mapping is in [docs/ide-memory.md](../../docs/ide-memory.md).

## Honest defaults

Nothing here ingests on its own. Installing the extension and opening a folder sends nothing. Every send is a preview followed by an explicit click, unless you opt into `statewave.autoIndex` yourself.
