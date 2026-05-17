# IDE memory — how Copilot / Cursor read the workspace back

The IDE Companion writes workspace memory **in**. This document is the **out** side: how an MCP-compatible assistant (GitHub Copilot, Cursor, or your own agent) retrieves it.

The retrieval side adds **no new MCP tools**. The companion was designed so the existing canonical Statewave MCP surface is sufficient:

```
statewave_get_context      statewave_get_timeline
statewave_search_memories  statewave_compile_subject   statewave_ingest_episode
```

If you can already call those (see [examples/copilot-mcp-memory](../examples/copilot-mcp-memory)), you can already consume IDE memory. Nothing to add or upgrade on the MCP server.

## Zero-config wiring — the plugin owns it

The product goal: **the developer runs only their Statewave server and installs the plugin.** The Statewave memory runtime then acts as the always-present *project brain* the assistant consults so it makes fewer mistakes — with no MCP file to hand-edit and no extra container to run.

From the single `statewave.url` / `statewave.apiKey` you set once in the plugin:

- **VS Code / Copilot:** registered **in-memory** via the VS Code MCP provider API (`vscode.lm.registerMcpServerDefinitionProvider`, VS Code ≥ 1.101). Launches a self-contained server bundled in the extension (`dist/mcp-stdio.cjs`) with the editor's own Node — **the API key is injected at launch and never written to disk.**
- **Cursor:** managed `statewave` entry merged into the global `~/.cursor/mcp.json`.
- **Windsurf:** managed entry merged into `~/.codeium/windsurf/mcp_config.json`.
- **Claude Code:** **local-scoped** entry in `~/.claude.json` (`projects["<abs-path>"].mcpServers.statewave`) — no approval prompt (a project `.mcp.json` would gate), auto-loaded next session. Surgical; never clobbers Claude Code's primary config.
- **Cline / Roo Code:** managed entry in their editor `globalStorage` settings (`cline_mcp_settings.json` / `mcp_settings.json`), located host-relative to the running editor.
- **Continue:** YAML-only. `~/.continue/config.yaml` is **created if absent**; if it already exists, the extension does **not** rewrite it (no safe zero-dep YAML merge) — it logs a one-time block to paste.

Every file path above is a home-dir / editor-storage location — **never the repo**, so no secret lands in version control. Each client is only touched when it is actually installed; the merge is surgical and idempotent; a parse failure is never clobbered. Governed by `statewave.mcp.autoWire` (master, default on) and `statewave.mcp.clients` (per-client allowlist, default all). A one-time, non-modal notice lists exactly which clients were wired.

No `npx`, no Docker MCP container, no second config surface. Docker MCP remains the right answer for headless/team/CI use, not the individual-developer path.

**Verifying it worked:** ask a question that needs project memory (below). Two gotchas, both expected:

- **Claude Code:** start a *new session* (or run `/mcp`) after first wiring — config is read at session start, not mid-session.
- **Phrase it as a tool call, not "memory."** "Statewave memory" collides with assistants' own memory features (Claude Code will go read local files and report "memory empty"). The first time, name the tool explicitly: *"Call the `statewave_get_context` tool for subject `repo:<owner>.<repo>` — what are this repo's conventions and recent changes?"* Once it sees the tool work, it reaches for it on its own.

On VS Code older than 1.101 the provider API is absent — the extension says so in its output channel and you configure manually (the canonical tool surface is unchanged).

## The subject is the contract

Everything the companion ingests is scoped to one **subject**:

- `repo:<owner>.<repo>` when the workspace has a git remote, else
- `workspace:<folder-slug>`, or
- whatever `statewave.subject` overrides it to.

> The Statewave server validates `subject_id` against `^[A-Za-z0-9_.\-:]+$`, which excludes `/`. The companion therefore sanitizes the subject — `/` becomes `.`, so the documented `repo:<owner>/<repo>` is emitted as `repo:<owner>.<repo>`. It's still stable and readable; it's just the form the server accepts. Any other out-of-set character collapses to `-`.

That subject is the single key an assistant queries. Pick it once; it stays stable. See [subject-strategy.md](./subject-strategy.md).

## Episode kinds the companion produces

| Kind | Meaning | Idempotency |
|---|---|---|
| `ide.workspace.indexed` | A full classified scan happened | content hash of the file set |
| `ide.project.summary` | Durable project model (languages, toolchain, layout, conventions) | content hash of the rendered summary |
| `ide.git.context` | Current branch + remote | branch + remote |
| `ide.docs.detected` | Digest of every documentation surface | content hash of the doc set |
| `ide.architecture.detected` | One per ADR / RFC / decision doc | path + content hash |
| `ide.file.changed` | One debounced save / create / delete | path + content hash (saves) |
| `ide.diagnostics.reported` | Digest of recurring errors/warnings (no source) | hash of the grouped signatures |

Idempotency is **content-addressable**: re-running an unchanged scan re-maps to the same `idempotency_key`, so Statewave dedupes; a changed workspace yields a new memory. These kinds are descriptive — Statewave does not require any specific value (see [episode-schema.md](./episode-schema.md)).

## Retrieval mapping (use the canonical tools)

| The assistant wants… | Call | Arguments |
|---|---|---|
| Project summary, conventions, relevant docs | `statewave_get_context` | `subject` = the workspace subject, `query` = the task at hand |
| Repo conventions specifically | `statewave_get_context` / `statewave_search_memories` | `subject`, `query: "repo conventions"` |
| Recent changed files | `statewave_get_timeline` | `subject`, `kinds: ["ide.file.changed"]` |
| Architecture / decision history | `statewave_get_timeline` | `subject`, `kinds: ["ide.architecture.detected"]` |
| Diagnostics summary | `statewave_get_timeline` | `subject`, `kinds: ["ide.diagnostics.reported"]` |
| "What is this project?" one-shot | `statewave_get_context` | `subject`, `query: "project overview"` |

`statewave_get_context` already returns compact, ranked context assembled from the compiled memories — the assistant should prefer it over stuffing raw history. `statewave_get_timeline` with a `kinds` filter is the precise path for "what changed / what was decided / what's broken" because the companion tags every episode with a stable `ide.*` kind.

### Example agent prompt flow

> User: "Get me up to speed on this repo before we touch the auth code."

1. Assistant calls `statewave_get_context` with `subject=repo:acme.widgets`, `query="auth code conventions and recent changes"`.
2. Statewave returns the compiled project summary + conventions + the most relevant ADRs/docs, already token-bounded.
3. (Optional) Assistant calls `statewave_get_timeline` with `kinds:["ide.architecture.detected"]` to cite the specific decision docs.

No raw chat scraping, no bespoke RAG index — the workspace memory was put there explicitly by the developer via the companion, and read back through the same MCP contract every other connector uses.

## Why no IDE-specific MCP tools

Goal: "use existing canonical MCP tools where possible; only add new tools if necessary." Retrieval needs are *subject-scoped context* and *kind-filtered timelines* — both already first-class on the server. Adding `ide_*` tools would fragment the surface for zero capability gain, so the companion deliberately ships none. If a future need genuinely cannot be expressed through the canonical tools, that is the bar for adding one.
