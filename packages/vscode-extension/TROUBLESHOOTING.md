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
| Copilot has no Statewave tools / no "Statewave Project Memory" in `MCP: List Servers` | Companion older than v0.1.5, or VS Code < 1.101 (no MCP provider API) | Update the companion to **v0.1.5+** and reload the window — the server then appears in `MCP: List Servers`; start it there, and enable the `statewave_*` tools in the Copilot Chat tools picker. On VS Code < 1.101 the MCP provider API is absent — update VS Code. |
| Stray `.cursor/`, `.roo/`… files | Older build wrote for all clients | Fixed — only detected clients now. Delete the strays; they won't return. Or run **Reset Local Integration**. |
| Continue config not updated | `~/.continue/config.yaml` already exists | YAML isn't auto-merged; the snippet to paste is logged in the output channel. |
| Codex doesn't see the `statewave_*` tools | Codex reads `~/.codex/config.toml` at session start | The companion detects the Codex extension, creates `~/.codex` if needed, and writes the `[mcp_servers.statewave]` table on activation; **fully restart Codex** (quit and reopen) to pick it up — it does not hot-reload MCP servers. |
| Large repo is slow on first build | Full symbol/doc pass once | Subsequent builds are incremental (cached); only changed files are reprocessed. |
| Want to undo everything | — | **Statewave: Reset Local Integration**, then reload the window. |
| GitHub sync: "could not resolve owner/name" | No github.com remote in the workspace root **and** no sibling sub-folder is a github.com repo either | The command auto-detects the workspace root, the active file's enclosing repo, multi-root folders, and one-level sub-folder repos. If still nothing, set `statewave.github.repo` explicitly. |
| GitHub sync: 401 / 403 | Token missing or lacks scope | Sign in to GitHub in VS Code (the command will prompt) — it requests the `repo` scope. Or set `statewave.github.token` in **User** settings. Public repos work with no token. |
| GitHub sync: 429 / rate limited | Hit the GitHub API hourly limit | Use a token (5000 req/h vs 60 unauth), trim `statewave.github.include`, lower `statewave.github.maxItems`, or wait. |
| GitHub sync silently uses no token (Cursor) | Some forks don't ship the built-in `github` auth provider | Set `statewave.github.token` in User settings as a fallback. |
| GitHub sync only got recent items | `statewave.github.since` is set, **or** the persisted last-sync cursor is recent | Clear `statewave.github.since`, and `Reset Local Integration` to drop the cursor for a full re-pull. |
| Project History: "could not detect the forge" | The git remote host isn't a recognised public forge (e.g. a self-managed instance) | Set `statewave.forge.kind` (e.g. `gitlab`/`gitea`/`azure-devops`) and, for self-hosted instances, `statewave.forge.host`. |
| Project History (Gitea/Forgejo): "is self-hosted — set host" | Gitea/Forgejo have no default host | Set `statewave.forge.host` (e.g. `git.example.com`) or `statewave.forge.baseUrl`. |
| Project History (Azure DevOps): "set repo to organization/project/repository" | Azure remotes don't always auto-parse | Set `statewave.forge.repo` to `org/project/repo`. For private projects set `statewave.forge.token` to a PAT (Code:Read, Work Items:Read). |
| Project History (GitLab/Bitbucket/Gitea): 401 / 403 | No editor auth provider for these forges and no token set | Set `statewave.forge.token` in **User** settings (GitLab personal/project token, Bitbucket access token, Gitea token). Public repos work with no token. |

Logs: **Output → "Statewave IDE Companion"**. Nothing is sent on activation;
ingestion is always preview-first.
