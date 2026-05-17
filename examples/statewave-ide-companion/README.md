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

## 3. Point Copilot / Cursor at the MCP server

The retrieval side reuses the **canonical** Statewave MCP tools — no IDE-specific tools were added.

- **Cursor:** copy [`mcp/cursor-mcp.json`](mcp/cursor-mcp.json) to `~/.cursor/mcp.json` (or the project `.cursor/mcp.json`).
- **VS Code / Copilot (and any MCP client):** see [`mcp/copilot-mcp.json`](mcp/copilot-mcp.json). Configure the client to launch `statewave-connectors mcp start` over stdio with `STATEWAVE_URL` / `STATEWAVE_API_KEY` in the environment.

Then ask the assistant something it could only know from workspace memory:

> "What are this repo's conventions and what changed recently?"

The assistant calls `statewave_get_context` with the workspace subject (e.g. `repo:smaramwbc.statewave-connectors` — `/` is sanitized to `.` for the server) for the project summary / conventions / docs, and `statewave_get_timeline` filtered by `ide.file.changed` / `ide.architecture.detected` / `ide.diagnostics.reported` for recent activity. The full mapping is in [docs/ide-memory.md](../../docs/ide-memory.md).

## Honest defaults

Nothing here ingests on its own. Installing the extension and opening a folder sends nothing. Every send is a preview followed by an explicit click, unless you opt into `statewave.autoIndex` yourself.
