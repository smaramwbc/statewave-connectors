# @statewavedev/connectors-cli

## 0.4.0

### Minor Changes

- Premium quickstart onboarding redesign: git-grounded repo identity, dependency preflight, live LiteLLM model discovery with key validation, multi-repo discover/seed, cross-platform verified IDE Companion install, honest server-verified output, no-Node bootstrap scripts, and legible light/dark prompts. The MCP server gains `statewave_list_subjects` and drains compilation fully.

### Patch Changes

- Updated dependencies []:
  - @statewavedev/mcp-server@0.4.0

## 0.3.0

### Minor Changes

- [#96](https://github.com/smaramwbc/statewave-connectors/pull/96) [`e658b01`](https://github.com/smaramwbc/statewave-connectors/commit/e658b01026d5b344a622c89e460f36c170a067e6) Thanks [@smaramwbc](https://github.com/smaramwbc)! - Show OS-aware guidance for setting environment variables, so users don't have to guess the syntax.

  The root help and `doctor` listed the variables the CLI reads (`STATEWAVE_URL`, connector tokens) but not _how_ to set them — which differs per OS and shell. Both now print a `setting environment variables` block tailored to the platform: `export … >> ~/.zshrc`/`~/.bashrc` on macOS/Linux (shell auto-detected via `$SHELL`), and `$env:` / `setx` / `set` on Windows. `doctor` shows it whenever a variable is unset.

- [#95](https://github.com/smaramwbc/statewave-connectors/pull/95) [`d67f98a`](https://github.com/smaramwbc/statewave-connectors/commit/d67f98ab21a228422d74834cc7f58848f87867bc) Thanks [@smaramwbc](https://github.com/smaramwbc)! - Add the **Streamable HTTP transport** — the Statewave MCP server can now serve remote clients, not just local ones.

  The server previously spoke MCP only over stdio (one child process per client). This adds a second transport: a single stateless JSON-RPC endpoint (`POST /mcp`) reachable over HTTP, so **Claude.ai custom connectors, ChatGPT, hosted agents, and teams pointing many agents at one shared memory** can all use the same five tools. The protocol logic is now shared between both transports (`handleJsonRpcMessage`) so they can't drift.

  Start it with `statewave-connectors mcp start --http` (or `statewave-mcp-server --http`), with `--host` / `--port` / `--path` / `--auth-token`. Safe by default: binds to `127.0.0.1`, validates the `Origin` header against DNS-rebinding, exposes an unauthenticated `/healthz`, and supports an optional bearer token (`--auth-token` / `STATEWAVE_MCP_AUTH_TOKEN`) that must be set before going public. The `initialize` handshake now echoes the client's requested protocol version for broader compatibility.

  Also adds **`mcp init claude-desktop`** — configures the Claude Desktop app's `claude_desktop_config.json` (OS-specific path) and prints the memory guidance to paste into custom instructions, since chat apps have no per-repo instruction file.

- [#95](https://github.com/smaramwbc/statewave-connectors/pull/95) [`d67f98a`](https://github.com/smaramwbc/statewave-connectors/commit/d67f98ab21a228422d74834cc7f58848f87867bc) Thanks [@smaramwbc](https://github.com/smaramwbc)! - Add `statewave-connectors mcp init <client>` — one command to wire an MCP client into Statewave memory.

  Removes the two things that stalled adoption of the MCP server: hand-editing client config and starting from an empty brain. `mcp init` knows where each client keeps its MCP config and which instruction file it reads, and drops in both — the server entry **and** the "call `statewave_get_context` first, persist durable facts" guidance that actually makes the tools get used.

  Supports **Claude Code** (`.mcp.json` + `CLAUDE.md`), **Cursor** (`.cursor/mcp.json` + `AGENTS.md`), **VS Code / Copilot** (`.vscode/mcp.json` + `.github/copilot-instructions.md`), and **Codex CLI** (`~/.codex/config.toml` + `AGENTS.md`). Prints the config + instruction blocks by default and writes nothing; `--write` applies them, merging into existing files without clobbering other servers and re-running idempotently. API keys are never written to a config file — the server reads `STATEWAVE_API_KEY` from its environment. Scope the memory with `--subject` (default `repo:<dir>`), point at a server with `--statewave-url`, and rename the server id with `--name`.

- [#95](https://github.com/smaramwbc/statewave-connectors/pull/95) [`d67f98a`](https://github.com/smaramwbc/statewave-connectors/commit/d67f98ab21a228422d74834cc7f58848f87867bc) Thanks [@smaramwbc](https://github.com/smaramwbc)! - Add `statewave-connectors quickstart` — zero-to-working in one command.

  Collapses the whole local setup (run a server, configure a client, seed memory) into a single command so a new user can go from nothing to a memory-backed assistant without hand-editing config or reading a checklist. It:

  1. ensures a Statewave server is up — **reuses** one already healthy at the target URL, otherwise brings up `api + admin + db` via `docker compose` (published images, debug mode, no API keys, admin auth disabled);
  2. waits for the API to become healthy;
  3. configures an MCP client (default **Claude Desktop**) to use it, pointing at the mcp-server this CLI ships with via the current Node executable — so it launches even in GUI apps that don't inherit a shell `PATH`;
  4. seeds the current repo's git history + README so the first `get_context` returns real answers.

  Then restart the client and ask about your project. `--down [--purge]` tears the stack back down. Flags: `--client`, `--subject`, `--statewave-url` (reuse an existing server, skip docker), `--api-port` / `--admin-port`, `--no-admin`, `--no-seed`.

  **Multiple clients, chosen interactively.** `quickstart` detects the MCP clients installed on the machine (Claude Code, Claude Desktop, Cursor, VS Code, Codex) and — on a TTY — shows the list (marking what's detected) and asks which to set up: Enter for the detected set, `a` for all, numbers to pick, `n` for none. Skip the prompt with `--client claude,cursor`, `--all`, or `--yes` (use detected). Non-interactive runs default to the detected set.

  **IDE Companion (capture side).** When you choose a VS Code / Cursor client, quickstart also installs the `statewavedev.statewave-ide-companion` extension for it — the half that _auto-captures_ your file + git activity into memory, complementing the MCP config that lets the assistant _read_ it. Choosing the editor is the consent, so there's no extra prompt; opt out with `--no-install-extension`. It runs the editor's own `--install-extension` CLI (soft-failing if the CLI is absent or the Marketplace id isn't reachable) and supports a local build via `--extension-vsix <path>`.

  **Polish.** Output now uses color (auto-disabled off a TTY, on `NO_COLOR`, or with `--no-color`) and shows an animated spinner during the long-running steps (waiting for the API to come up, compiling memory) so the CLI never looks frozen. Seeding shows live ingest progress and runs requests concurrently.

  **Optional LLM key.** When starting a fresh server, quickstart offers an LLM API key and explains the trade-off: with a key it enables the **LLM compiler + semantic embeddings** (cleaner, deduplicated, meaning-recalled memory); without one it uses the built-in **heuristic compiler + keyword matching** (fully offline, zero cost, coarser). The key is read interactively or from `--llm-api-key` / `STATEWAVE_LITELLM_API_KEY` / `OPENAI_API_KEY`, optionally with `--llm-model` (any LiteLLM id; default OpenAI `gpt-4o-mini`), and `--no-llm` forces keyless. It's passed to the container via the environment — never written to the generated compose file.

  Also adds `--server-bin` / `--server-command` to `mcp init`, to point a client at a local or custom server launch instead of `npx` (used by `quickstart`, and handy for testing unpublished builds).

  **Editor resolution + lighter footprint.** The IDE Companion install resolves each chosen editor by its own app-bundle CLI (e.g. `/Applications/Cursor.app/.../bin/cursor`) instead of trusting the PATH `code`, so picking both VS Code and Cursor installs into _both_ real apps — and the output names the editor it actually resolved to. The instruction block written into `CLAUDE.md`/`AGENTS.md`/`copilot-instructions.md` is trimmed to three lines, and `--no-instructions` writes the MCP config only (no guidance block) for both `quickstart` and `mcp init`.

- [#95](https://github.com/smaramwbc/statewave-connectors/pull/95) [`d67f98a`](https://github.com/smaramwbc/statewave-connectors/commit/d67f98ab21a228422d74834cc7f58848f87867bc) Thanks [@smaramwbc](https://github.com/smaramwbc)! - Add `statewave-connectors mcp seed` — fix the empty-brain problem on day one.

  `mcp init` wires a client up, but a freshly-configured assistant still queries a subject with nothing in it. `mcp seed` solves that: it reads the current repo's **local** git history and README, maps them to episodes, ingests them, and compiles the subject — so the very first `statewave_get_context` returns real answers ("what changed and why", project overview) instead of a blank.

  Reads git and the filesystem only — **no tokens, no network** — and is dry-run by default (prints the plan, ingests nothing); `--write` ingests and compiles. Ingestion runs with bounded concurrency (`--concurrency`, default 8) and shows **live progress** (a single updating status line on a TTY, milestone lines otherwise) so a large repo doesn't look frozen; failures are collected and summarized instead of aborting the run. Re-running is safe: commits dedupe on their sha and the README updates in place. Scope with `--subject` (default `repo:<dir>`), bound history with `--max-commits` (default 200), and skip the overview with `--no-docs`. Pairs with `mcp init` as the two-command setup: `mcp init <client> --write && mcp seed --write`.

### Patch Changes

- Updated dependencies [[`cc5bc65`](https://github.com/smaramwbc/statewave-connectors/commit/cc5bc6588eec2f285f7bc20a4d9438e2762ec71c), [`d67f98a`](https://github.com/smaramwbc/statewave-connectors/commit/d67f98ab21a228422d74834cc7f58848f87867bc)]:
  - @statewavedev/connectors-jira@0.4.1
  - @statewavedev/mcp-server@0.3.0
