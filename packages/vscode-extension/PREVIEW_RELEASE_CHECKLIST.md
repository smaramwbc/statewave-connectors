# Preview release checklist — Statewave IDE Companion

First **public preview** (`preview: true`, `0.1.0`). Work top-to-bottom.
Automated gate first, then the manual matrix, then publish.

## 0. Automated gate (run locally)

```sh
pnpm --filter statewave-ide-companion preview-release
```

Runs: build (deps + extension) → lint → typecheck → test → `vsce package` →
leak-scan. Must end with `leak-scan: CLEAN`. Equivalent manual run:

```sh
pnpm --filter "statewave-ide-companion..." run build
pnpm --filter statewave-ide-companion run lint
pnpm --filter statewave-ide-companion run typecheck
pnpm --filter statewave-ide-companion run test
pnpm --filter statewave-ide-companion run package
pnpm --filter statewave-ide-companion run leak-scan
```

- [ ] `preview-release` exits 0; `leak-scan: CLEAN`.
- [ ] `git status` clean; no `*.vsix` accidentally staged (`media/icon.png` IS committed — it's the brand asset).
- [ ] `ide-core` unit tests green (deterministic core: queue, scheduler, cache, diagnose, transparency, understanding, detect, instructions).

## 1. Manual smoke matrix (Extension Development Host — required)

Install the packaged VSIX into a clean editor profile
(`code --install-extension statewave-ide-companion.vsix`) unless noted.

- [ ] **Clean clone install** — fresh `git clone`, `pnpm i`, `preview-release`, install VSIX in a clean VS Code profile. Activates < ~200 ms; status bar appears; no errors in Output.
- [ ] **Local Statewave server** — `statewave.url=http://localhost:8100`; Build Project Memory → preview → Ingest; status bar goes pending → compiling → ready; Project Understanding renders.
- [ ] **Offline** — server down: status bar "offline"; Diagnose shows the fix; preview still works; no crash/unhandled rejection.
- [ ] **Invalid URL / bad auth** — garbage URL → graceful error; valid URL + wrong `apiKey` → Diagnose flags 401 with fix.
- [ ] **Untrusted workspace** — open folder as Restricted: no MCP wiring, no instruction files, no watcher; trusting it applies behavior with no reload.
- [ ] **Cursor install** — install VSIX in Cursor; `~/.cursor/mcp.json` gains a managed `statewave` server (other servers preserved); only `.cursor` rules file written.
- [ ] **Copilot MCP wiring** — VS Code ≥ 1.101: in-memory MCP provider registered (Output line); Copilot agent mode lists `statewave_*` tools.
- [ ] **Assistant instructions** — only detected clients get a file; `.github/copilot-instructions.md` block present and read-write directive correct; `read-only`/`off` respected.
- [ ] **First-run walkthrough** — first activation opens the walkthrough once; steps complete on the linked commands; never re-opens.
- [ ] **Project Understanding webview** — opens; sections + "Generated from" provenance; scripts disabled; theme-correct.
- [ ] **Diagnose command** — report covers server/auth/subject/MCP/clients/compile; "Copy report" works.
- [ ] **Reset Local Integration** — modal confirm; removes MCP entries + instruction files/blocks (user content preserved) + clears cache; server/memory untouched.
- [ ] **Incremental** — second Build is fast (cache hit, only changed files); large repo stays responsive.
- [ ] **Privacy** — Show Indexed Files: `.env`/keys absent and marked hard-skip; node_modules/build skipped; redaction on.

## 2. VSIX leak scan (gate)

- [ ] `pnpm --filter statewave-ide-companion run leak-scan` → `CLEAN`.
- [ ] Manual spot check: `unzip -l statewave-ide-companion.vsix` shows only `dist/*.cjs`, docs, `walkthrough/`, `media/icon.*`, manifest — **no** `src/`, `*.map`, `node_modules`, `.env`, internal `MARKETPLACE_*`.

## 3. Marketplace assets (see MARKETPLACE_ASSETS.md)

- [x] `media/icon.png` 128×128 (official brand mark) committed; `package.json#icon` set.
- [ ] README screenshots embedded; 60-sec demo GIF; short + long descriptions finalized.
- [ ] `publisher` `statewavedev` is a **registered** Marketplace publisher; PAT available.

## 4. Publish dry-run

```sh
cd packages/vscode-extension
pnpm exec vsce package --no-dependencies -o statewave-ide-companion.vsix
pnpm exec vsce ls --no-dependencies        # final file list review
# (publish requires private:false — do NOT commit that flip)
```

- [ ] VSIX installs and activates from disk in VS Code **and** Cursor.

## 5. Publish

```sh
cd packages/vscode-extension
# release pipeline only: temporarily set "private": false
pnpm exec vsce publish --no-dependencies --pat "$VSCE_PAT"
# or: pnpm exec vsce publish minor --no-dependencies   (bumps version)
```

- [ ] Listing renders (icon, banner, README, categories, preview badge).
- [ ] Install **from Marketplace** in clean VS Code + Cursor; re-run smoke matrix items 1–2.
- [ ] Tag the release; update `CHANGELOG.md`.

## 6. Post-publish

- [ ] Watch Q&A / issues (`smaramwbc/statewave`).
- [ ] Keep `preview: true` until the manual matrix is green across ≥2 real repos.
