# Troubleshooting — Statewave IDE Companion

Run **`Statewave: Diagnose`** first — it checks every item below and prints
actionable fixes you can copy.

| Symptom | Likely cause | Fix |
|---|---|---|
| Status bar: "Statewave offline" | Server not running / wrong URL | Start your Statewave instance; check `statewave.url` (default `http://localhost:8100`). |
| 401 / "auth rejected" | Missing/invalid API key | Set `statewave.apiKey` in **User** settings. |
| 422 on ingest | Subject contains characters the server rejects | The plugin sanitizes `/`→`.` automatically; if you set `statewave.subject` manually, use only `[A-Za-z0-9_.\-:]`. |
| Episodes ingested but assistant "finds nothing" | Subject not compiled yet | Status bar shows compile state; it auto-schedules. Force with **Statewave: Compile Project Memory**. |
| Assistant ignores the memory | It needs the tool prompt first time | Ask: *"call the `statewave_get_context` tool for this repo"*. Say **tool**, not "memory". |
| Claude Code doesn't see it | New config needs a new session | Start a new Claude Code session or run `/mcp`. |
| Copilot has no Statewave tools | VS Code < 1.101 (no MCP provider API) | Update VS Code, or configure MCP manually (see docs/ide-memory.md). |
| Stray `.cursor/`, `.roo/`… files | Older build wrote for all clients | Fixed — only detected clients now. Delete the strays; they won't return. Or run **Reset Local Integration**. |
| Continue config not updated | `~/.continue/config.yaml` already exists | YAML isn't auto-merged; the snippet to paste is logged in the output channel. |
| Large repo is slow on first build | Full symbol/doc pass once | Subsequent builds are incremental (cached); only changed files are reprocessed. |
| Want to undo everything | — | **Statewave: Reset Local Integration**, then reload the window. |

Logs: **Output → "Statewave IDE Companion"**. Nothing is sent on activation;
ingestion is always preview-first.
