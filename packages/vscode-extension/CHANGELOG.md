# Changelog

All notable changes to the Statewave IDE Companion.

## [1.0.0] — First stable public developer release

Drops the Marketplace "Preview" ribbon and cuts the first stable version.
No behaviour change vs 0.1.13 — same code, same defaults; the version bump
reflects that the wider Statewave stack is at 1.0 and this extension is
catching its naming up.

### Compatibility

- `engines.vscode` raised from `^1.85.0` to `^1.125.0` to match the
  bundled `@types/vscode`. The Marketplace continues to serve v0.1.13 to
  users on older VS Code automatically.

## [0.1.13] — Preview

### Docs

- README + first-run walkthrough lead with `npx @statewavedev/connectors-cli
  quickstart` — one command spins up the server + admin + DB. The hand-rolled
  Docker Compose example moves into a collapsible "advanced" section.

## [0.1.12] — Preview

### Fixed

- Watcher ignores editor atomic-save artifacts (`*.tmp.NNNNN.XXX`), vim/emacs
  swap & lock files, embedded-DB storage (`*.wt`, `*.mdb`, `WiredTiger*`,
  `mongod.lock`), and common Docker-Compose DB volume dirs (`data-node`,
  `mongo[db]-data`, `pg/postgres-data`, `mysql-data`, `redis-data`,
  `elasticsearch-data`, `meili_data*`, `data.ms`). Stops runtime container
  churn (e.g. MongoDB / Meilisearch journal writes) from being ingested.

## [0.1.11] — Preview

### Changed

- The watcher now emits `ide.code.symbols.changed` — per-file symbol-level
  deltas (added / removed / moved) — instead of one `ide.file.changed`
  per save. Formatter-only / whitespace saves emit nothing. Non-source
  files (docs, configs) still use the coarse `ide.file.changed` signal.

### Fixed

- Status-bar tooltip "Subject:" line no longer disappears after toggling
  unrelated `statewave.*` settings.
- An unresolvable subject (e.g. `subjectStrategy=repo` with no parseable
  git remote) now shows **"Statewave: subject unresolved"** in the
  status bar — same error treatment as `offline` — with an actionable
  tooltip, instead of silently masking the problem behind a stale
  "N memories ready" from a previous workspace.

## [0.1.10] — Preview

### Fixed

- Status-bar tooltip now shows the compiled memory count instead of "unknown".

## [0.1.9] — Preview

### Added — history connectors for GitLab, Bitbucket, Gitea/Forgejo and Azure DevOps

- **Project-decision history is no longer GitHub-only.** The opt-in
  GitHub history connector (v0.1.1) now has parity peers for four more
  forges, each scoped to the same workspace subject and ingested through
  the same explicit, preview-first flow. The assistant can finally read
  *why* a project decided things even when it doesn't live on GitHub.
- New manual commands: **Statewave: Sync GitLab Project History**,
  **Statewave: Sync Bitbucket Project History**, **Statewave: Sync
  Gitea/Forgejo Project History**, **Statewave: Sync Azure DevOps
  Project History**. Each is gated behind its own enablement setting,
  follows the same dry-run/preview UX as the GitHub command, and never
  runs on activation or in the watcher loop.
- New per-forge settings under `statewave.gitlab.*`, `statewave.bitbucket.*`,
  `statewave.gitea.*`, and `statewave.azure.*` — `enabled`, `repo` /
  `project` override, `token` (fallback only — prefer the host's
  built-in auth provider), `host` (for self-hosted instances), `since`,
  `maxItems`. Defaults: **off**.
- Each connector ships its own unit + mapper tests and live-API smoke
  tests; the smoke pass for GitLab and Gitea was tightened before this
  release.

## [0.1.8] — Preview

### Fixed — status-bar tooltip stuck on "Memory: unknown"

- **The status tooltip now shows a real compiled-memory count** for the
  current subject. Previously the engine defined a `setMemories(n)` hook
  but nothing ever called it, so the `Memory:` line read `unknown`
  permanently even after a successful compile. The companion now probes
  `/v1/memories/search` lazily — after every compile, on `offline →
  online` recovery, and on a `statewave.*` config change — and surfaces
  `results.length`. The probe is best-effort; on failure the previously
  known count stands (no flicker back to "unknown"). `limit=200` is a
  pragmatic cap for very large subjects.

## [0.1.7] — Preview

### Added — `ide.project.commands` memory signal

- **The companion now remembers the commands you'd run in this project**, so
  the assistant can answer "how do I test / build / start this?" from memory
  instead of guessing. It collects only the **declared command surface**:
  `package.json` `scripts`, `Makefile` targets, and the `[project.scripts]` /
  `[tool.poetry.scripts]` tables of `pyproject.toml`.
- **Privacy-preserving by construction.** Only those three manifests are read —
  never source-file bodies, lockfiles, env files, or assistant chat. Command
  strings are redacted (when redaction is enabled) since a script line can embed
  a literal token. Idempotency is content-addressable on the declared surface,
  so re-running with unchanged manifests dedupes.
- New episode kind `ide.project.commands`. Retrieve it with
  `statewave_get_timeline` (`kinds: ["ide.project.commands"]`) — see
  [ide-memory.md](https://github.com/smaramwbc/statewave-connectors/blob/main/docs/ide-memory.md).

No assistant chat is read, and no new always-on collection runs — the signal is
built during the same explicit, preview-first Build Project Memory flow as every
other episode.

## [0.1.6] — Preview

### Fixed — status stuck on "offline" after the server comes back

- **The status bar no longer stays on "Statewave offline" after you restart
  the Statewave backend.** Previously the reachability flag was only ever set
  at extension startup and when you changed a `statewave.*` setting — there was
  no periodic re-check, so once the server went down the status was stuck on
  "offline" until you reloaded the editor window. The companion now runs a
  self-rescheduling reachability poll: **~30 s while offline** (fast recovery)
  and **~5 min while online** (cheap heartbeat). A server restart is detected
  automatically; no window reload needed.
- **Health checks now hit `/readyz`** (API + database readiness) instead of the
  bare base URL (which returns 404 from the API root and only proved the port
  was open).
- **New `Statewave: Reconnect` command** (also offered in the status menu when
  offline) forces an immediate re-probe.
- **The status menu re-probes on open**, and **Build Project Memory re-probes
  first if it believed the server was offline**, so a stale "offline" never
  makes an action look pointless.
- **Clear status progression: offline → connecting → online.** A probe in
  flight shows "connecting…" rather than a stuck "offline". No noisy
  notifications — the Output channel narrates each reconnect attempt and its
  result; the status bar updates quietly.

No new data collection, no new memory signals, no IDE feature expansion — a
focused reliability fix. Same VSIX ships to the VS Code Marketplace and (new in
this release) Open VSX for Cursor / Windsurf.

## [0.1.5] — Preview

### Fixed — Copilot / VS Code MCP server never appeared (critical)

- **The `statewave` MCP server was silently dropped by VS Code**, so it
  never showed in `MCP: List Servers` and Copilot never got the
  `statewave_*` tools. Root cause: `McpStdioServerDefinition` has a
  **positional** constructor — `(label, command, args, env, version)` —
  but the companion was passing a single options object. VS Code then
  read `command` as `undefined` and discarded the definition. The
  companion now constructs it positionally and sets `cwd` as a property.
- This affected every VS Code / Copilot user since v0.1.0. (Claude Code
  was unaffected — it uses a separate file-based config path.)
- After updating: reload the VS Code window, then run `MCP: List
  Servers` — **Statewave Project Memory** now appears; start it and
  Copilot agent mode can read project memory.

## [0.1.4] — Preview

### Fixed — Codex wiring on extension-only machines

- **Codex is now detected by its VS Code extension, not only the
  `~/.codex` directory.** v0.1.3 wired Codex only when `~/.codex` already
  existed — but that directory is created lazily, so on a machine where
  you run Codex through the **IDE extension** (`openai.chatgpt`) rather
  than the CLI it often doesn't exist yet, and `Diagnose` showed Codex
  missing from "MCP wired". The companion now also detects the Codex
  extension and **creates `~/.codex/` itself** before writing the
  surgical `[mcp_servers.statewave]` table into `~/.codex/config.toml`
  (the CLI and the extension share that one file).
- After updating: reload the VS Code window, then **fully restart the
  Codex extension** (close and reopen it / reload the window again) so it
  re-reads `config.toml` — Codex does not hot-reload MCP servers.

## [0.1.3] — Preview

### Added — Codex support

- **Codex (OpenAI) is now a first-class wired client.** Codex does not
  read VS Code's MCP registry, so — like Claude Code — it needs its own
  config. The companion now writes a surgical `[mcp_servers.statewave]`
  table into `~/.codex/config.toml` (home dir, never the repo; other
  tables preserved; idempotent), so the Codex agent gets the
  `statewave_*` tools. Restart Codex / start a new session to load it.
- `codex` added to `statewave.mcp.clients` (default on; wired only when
  `~/.codex` exists).
- Reflexive instruction file for Codex: the read+write directive is
  merged into `AGENTS.md` (delimited block; your own content untouched).

## [0.1.2] — Preview

### Docs

- README + the "Connect your server" walkthrough step now include a
  copy-paste Docker Compose example that runs the Statewave **server**
  (`statewavedev/statewave`), the **admin console**
  (`statewavedev/statewave-admin`), and the **database**
  (`pgvector/pgvector`) — with local-dev defaults and a
  production-hardening note.

### Fixed

- `PR_BODY.md` (an internal process file) is no longer packaged into the
  `.vsix`; `.vscodeignore` excludes it and `leak-scan` flags it as
  defense-in-depth.

## [0.1.1] — Preview

### Added — opt-in GitHub history connector (the "why")

- New manual command **Statewave: Sync GitHub Project History**. Pulls
  issues, PRs, comments, reviews, and releases via
  `@statewavedev/connectors-github` and ingests them under this workspace's
  subject — captures the project-decision history the IDE plugin alone
  can't see. Preview-first; ingestion still requires the explicit Ingest
  click; never on activation or in the watcher loop.
- New settings (all under `statewave.github.*`): `enabled` (default
  **off**), `repo` (optional `owner/name` override; defaults to the
  workspace's github.com remote), `token` (**fallback only**; default path
  is VS Code's built-in `github` auth session — OS keychain, no token in
  settings/repo), `include`, `since`, `maxItems`.
- Cursor of last-sync time persisted in `workspaceState`; subsequent runs
  are incremental.
- Status-bar menu shows the GitHub action only when `statewave.github.enabled`.
- **Umbrella-workspace repo detection:** if the workspace root isn't a git
  repo (multi-repo umbrella folder), the command now also checks the
  active editor's enclosing repo, every VS Code multi-root folder, and a
  one-level scan of sibling sub-folders. Single match → silent; multiple
  matches → a QuickPick with an option to remember the choice as a
  workspace setting.

### Limits

- Designed for github.com remotes (GitLab / Bitbucket / Gitea coverage is
  tracked separately).
- Cursor / Windsurf / VSCodium that don't ship the built-in `github` auth
  provider can use `statewave.github.token` as a fallback.

## [0.1.0] — Preview

First public preview. A trustworthy, local, deterministic project brain for
your AI assistant.

### Memory
- Workspace scan, project summary, git context + history, full doc content
  (README/docs/ADR/RFC), lightweight code structure (symbols only, no source
  bodies), diagnostics digest, file-change events.
- Content-addressable episodes (idempotent dedupe).
- Parallel ingest queue (configurable concurrency, retry/backoff,
  cancellation, partial-failure isolation, live progress).
- Async, debounced+throttled compile scheduler with an explicit state
  machine; freshness triggers on ingest, window focus, and an idle
  safety-net so captured facts reliably become memory.
- Incremental, cached indexing — only changed files are reprocessed;
  survives reloads.

### Zero-config MCP wiring
- Copilot (in-memory provider), Cursor, Windsurf, Claude Code, Cline, Roo,
  Continue — only when actually installed; secrets never written to the repo.
- Reflexive read+write instruction files per detected client.

### Trust & visibility
- Reactive status bar (initializing/indexing/syncing/compiling/ready/
  offline/errors) with a click-through action & diagnostics menu.
- `Statewave: Diagnose` — actionable health report.
- `Statewave: Show Indexed Files` — exact "why indexed / why skipped".
- `Statewave: Open Project Understanding` — provenance-backed live summary.
- First-run walkthrough; `Statewave: Reset Local Integration`.

### Privacy
- Secret files (`.env*`, `*.pem`, keys, credentials…) are a hard skip that
  cannot be opted in.
- Never reads assistant chat. No telemetry. Vendor-neutral.
- Honours workspace trust (no side effects in untrusted workspaces).
