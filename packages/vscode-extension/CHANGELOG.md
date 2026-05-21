# Changelog

All notable changes to the Statewave IDE Companion.

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
