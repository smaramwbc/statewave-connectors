# Marketplace readiness — Statewave IDE Companion

Status: **engineering-complete, pre-publish gated on binary assets + a
live-host smoke pass.** This file is excluded from the VSIX.

## Automated validation (passing now)

| Check | Result |
|---|---|
| `pnpm build` (workspace, esbuild bundle) | ✅ exit 0 |
| `pnpm lint` (tsc strict, noUncheckedIndexedAccess) | ✅ exit 0 |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm test` (19 packages) | ✅ exit 0 |
| `@statewavedev/ide-core` unit tests | ✅ 101 passing |
| `vsce package --no-dependencies` | ✅ 17 files, ~55 KB |
| VSIX leak scan (src / *.map / node_modules / .env / secrets) | ✅ CLEAN |
| Activation cost | ✅ inert: registers commands + status bar; **no scan/network/ingest on activation** |
| Secrets in repo | ✅ none; MCP secrets only in home/editor-storage; instruction files carry none |
| Telemetry | ✅ none |

The deterministic core (ingest queue, compile scheduler/state machine,
status derivation, index cache, diagnose, transparency, understanding,
client detection, instruction merge) is **pure and unit-tested in
ide-core** — onboarding/cache/compile-scheduling/diagnostics/status-state
logic is covered there without needing an editor host.

## Manual gates before `vsce publish` (honest list)

| Gate | Why manual | Action |
|---|---|---|
| ~~`media/icon.png` + `package.json#icon`~~ ✅ DONE | — | Official brand mark vendored from `statewave-web/public/statewave_icon_dark.png`, committed, wired |
| Listing banner / screenshots / demo GIF | Binary media | Capture build → status-bar → "ask assistant" flow |
| Make `private:false` for publish | It's `private` so changesets/npm ignore it | Flip only in the publish pipeline, never committed to main |
| Publisher + PAT | Marketplace account secret | `vsce publish` with the `statewavedev` publisher PAT |

## Live-host smoke matrix (run in an Extension Development Host)

Pure logic is unit-tested; these exercise the VS Code glue and must be run
once interactively (cannot be automated in this environment):

- [ ] **Install test** — install the VSIX in clean VS Code; activates < 200 ms; status bar appears; no errors.
- [ ] **Fresh workspace** — open a new repo; walkthrough opens once; nothing ingested until Build → Ingest.
- [ ] **Large monorepo** — first build completes; second build is incremental (cache hit, fast); status bar stays responsive.
- [ ] **Offline** — `statewave.url` unreachable: status bar "offline", Diagnose gives the fix, no crash, ingest preview still works.
- [ ] **Server unavailable mid-ingest** — partial failure isolated, retries/backoff, cancellable; status shows errors.
- [ ] **MCP absent (VS Code < 1.101)** — provider not registered; Diagnose explains; file-based clients still wired.
- [ ] **Privacy** — Show Indexed Files: `.env`/keys absent and marked hard-skip; node_modules/build skipped.
- [ ] **Memory freshness** — ingest → status "compile pending" → "ready"; focus/idle safety-net compiles assistant-written facts.
- [ ] **Multi-client** — only detected clients get instruction files; Reset Local Integration cleanly removes everything.
- [ ] **Untrusted workspace** — no MCP wiring/instruction writes/watcher; trust → behavior applies.

## Publish checklist

1. [x] Icon — official brand PNG committed + wired (done).
2. [ ] Add screenshots + GIF to README; verify Marketplace render.
3. [ ] Run the live-host smoke matrix above (all boxes).
4. [ ] `pnpm build && pnpm test` green; `vsce package` clean.
5. [ ] Bump `version`, update `CHANGELOG.md`.
6. [ ] `vsce publish` with the `statewavedev` PAT (publish-only `private:false`).
7. [ ] Tag release; verify Marketplace listing + install from Marketplace.
8. [ ] Smoke the published extension in VS Code **and** Cursor.

## Recommended next milestone (post-launch)

**"Team & scale".** (1) Memory-count + last-compiled surfaced from the
server so the status bar shows real numbers; (2) multi-root workspace
support; (3) shared/team subject conventions + a committed
`.statewave.json` project config; (4) extension integration tests via
`@vscode/test-electron` in CI; (5) optional ambient autoIndex tuned with
the throttled compile so "always fresh" is safe on big repos; (6)
Marketplace analytics-free install funnel review + a 60-second demo.
