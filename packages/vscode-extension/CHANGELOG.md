# Changelog

All notable changes to the Statewave IDE Companion.

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
