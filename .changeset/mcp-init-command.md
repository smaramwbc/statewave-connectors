---
"@statewavedev/connectors-cli": minor
---

Add `statewave-connectors mcp init <client>` — one command to wire an MCP client into Statewave memory.

Removes the two things that stalled adoption of the MCP server: hand-editing client config and starting from an empty brain. `mcp init` knows where each client keeps its MCP config and which instruction file it reads, and drops in both — the server entry **and** the "call `statewave_get_context` first, persist durable facts" guidance that actually makes the tools get used.

Supports **Claude Code** (`.mcp.json` + `CLAUDE.md`), **Cursor** (`.cursor/mcp.json` + `AGENTS.md`), **VS Code / Copilot** (`.vscode/mcp.json` + `.github/copilot-instructions.md`), and **Codex CLI** (`~/.codex/config.toml` + `AGENTS.md`). Prints the config + instruction blocks by default and writes nothing; `--write` applies them, merging into existing files without clobbering other servers and re-running idempotently. API keys are never written to a config file — the server reads `STATEWAVE_API_KEY` from its environment. Scope the memory with `--subject` (default `repo:<dir>`), point at a server with `--statewave-url`, and rename the server id with `--name`.
