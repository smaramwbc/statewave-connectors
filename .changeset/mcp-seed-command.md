---
"@statewavedev/connectors-cli": minor
---

Add `statewave-connectors mcp seed` — fix the empty-brain problem on day one.

`mcp init` wires a client up, but a freshly-configured assistant still queries a subject with nothing in it. `mcp seed` solves that: it reads the current repo's **local** git history and README, maps them to episodes, ingests them, and compiles the subject — so the very first `statewave_get_context` returns real answers ("what changed and why", project overview) instead of a blank.

Reads git and the filesystem only — **no tokens, no network** — and is dry-run by default (prints the plan, ingests nothing); `--write` ingests and compiles. Ingestion runs with bounded concurrency (`--concurrency`, default 8) and shows **live progress** (a single updating status line on a TTY, milestone lines otherwise) so a large repo doesn't look frozen; failures are collected and summarized instead of aborting the run. Re-running is safe: commits dedupe on their sha and the README updates in place. Scope with `--subject` (default `repo:<dir>`), bound history with `--max-commits` (default 200), and skip the overview with `--no-docs`. Pairs with `mcp init` as the two-command setup: `mcp init <client> --write && mcp seed --write`.
