---
"@statewavedev/connectors-cli": minor
---

Add `statewave-connectors quickstart` — zero-to-working in one command.

Collapses the whole local setup (run a server, configure a client, seed memory) into a single command so a new user can go from nothing to a memory-backed assistant without hand-editing config or reading a checklist. It:

1. ensures a Statewave server is up — **reuses** one already healthy at the target URL, otherwise brings up `api + admin + db` via `docker compose` (published images, debug mode, no API keys, admin auth disabled);
2. waits for the API to become healthy;
3. configures an MCP client (default **Claude Desktop**) to use it, pointing at the mcp-server this CLI ships with via the current Node executable — so it launches even in GUI apps that don't inherit a shell `PATH`;
4. seeds the current repo's git history + README so the first `get_context` returns real answers.

Then restart the client and ask about your project. `--down [--purge]` tears the stack back down. Flags: `--client`, `--subject`, `--statewave-url` (reuse an existing server, skip docker), `--api-port` / `--admin-port`, `--no-admin`, `--no-seed`.

**Multiple clients, chosen interactively.** `quickstart` detects the MCP clients installed on the machine (Claude Code, Claude Desktop, Cursor, VS Code, Codex) and — on a TTY — shows the list (marking what's detected) and asks which to set up: Enter for the detected set, `a` for all, numbers to pick, `n` for none. Skip the prompt with `--client claude,cursor`, `--all`, or `--yes` (use detected). Non-interactive runs default to the detected set.

**IDE Companion (capture side).** When you choose a VS Code / Cursor client, quickstart also installs the `statewavedev.statewave-ide-companion` extension for it — the half that *auto-captures* your file + git activity into memory, complementing the MCP config that lets the assistant *read* it. Choosing the editor is the consent, so there's no extra prompt; opt out with `--no-install-extension`. It runs the editor's own `--install-extension` CLI (soft-failing if the CLI is absent or the Marketplace id isn't reachable) and supports a local build via `--extension-vsix <path>`.

**Polish.** Output now uses color (auto-disabled off a TTY, on `NO_COLOR`, or with `--no-color`) and shows an animated spinner during the long-running steps (waiting for the API to come up, compiling memory) so the CLI never looks frozen. Seeding shows live ingest progress and runs requests concurrently.

**Optional LLM key.** When starting a fresh server, quickstart offers an LLM API key and explains the trade-off: with a key it enables the **LLM compiler + semantic embeddings** (cleaner, deduplicated, meaning-recalled memory); without one it uses the built-in **heuristic compiler + keyword matching** (fully offline, zero cost, coarser). The key is read interactively or from `--llm-api-key` / `STATEWAVE_LITELLM_API_KEY` / `OPENAI_API_KEY`, optionally with `--llm-model` (any LiteLLM id; default OpenAI `gpt-4o-mini`), and `--no-llm` forces keyless. It's passed to the container via the environment — never written to the generated compose file.

Also adds `--server-bin` / `--server-command` to `mcp init`, to point a client at a local or custom server launch instead of `npx` (used by `quickstart`, and handy for testing unpublished builds).

**Editor resolution + lighter footprint.** The IDE Companion install resolves each chosen editor by its own app-bundle CLI (e.g. `/Applications/Cursor.app/.../bin/cursor`) instead of trusting the PATH `code`, so picking both VS Code and Cursor installs into *both* real apps — and the output names the editor it actually resolved to. The instruction block written into `CLAUDE.md`/`AGENTS.md`/`copilot-instructions.md` is trimmed to three lines, and `--no-instructions` writes the MCP config only (no guidance block) for both `quickstart` and `mcp init`.
