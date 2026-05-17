# Manual smoke test — step by step

Compact operational runbook for the human validation gate. Follow top to
bottom. Each step has an **action** and the **expected** result; tick the
box only if expected matches. STOP markers are hard fails — fix before
publishing. ~30–45 min total.

Pairs with the formal gate in `PREVIEW_RELEASE_CHECKLIST.md` (this is the
"how", that is the "what").

---

## 0. Prep (once)

```sh
# from repo root
pnpm install
pnpm --filter statewave-ide-companion preview-release   # must end: leak-scan: CLEAN
```

- Have a **real repo with a git remote** to test in (not this monorepo — use any small project).
- Start a local Statewave server on `http://localhost:8100` (for online steps). Offline steps work without it.
- Editors: **VS Code ≥ 1.101** (for Copilot MCP provider) and **Cursor**.

---

## A. VS Code Extension Development Host (fast loop)

1. Open `packages/vscode-extension` in VS Code → press **F5**.
   - [ ] **Expected:** a `[Extension Development Host]` window opens. Output → "Statewave IDE Companion" shows `activated (no data is sent on activation)`. **STOP** if anything is sent on activation.
2. In the dev-host window, open your **test repo** (File → Open Folder).
   - [ ] **Expected:** the **Get started with Statewave** walkthrough opens once. Status bar shows `🗄 Statewave …`.
3. Status bar item → click it.
   - [ ] **Expected:** QuickPick with live subject/server/compile line + actions (Build, Compile, Open Project Understanding, Show Indexed Files, Diagnose, Configure).
4. Run **Statewave: Show Indexed Files**.
   - [ ] **Expected:** a doc listing indexed vs skipped with reasons. Add a throwaway `.env` with `SECRET=x` to the test repo, re-run.
   - [ ] **Expected:** `.env` appears under **Skipped** with "secret/credentials … hard rule". **STOP** if `.env` is ever in Indexed.
5. `Cmd+,` → set `statewave.url=http://localhost:8100` (+ `statewave.apiKey` if your server needs one).
   - [ ] **Expected:** status bar leaves "offline"/unknown.
6. Run **Statewave: Build Project Memory**.
   - [ ] **Expected:** Output shows an episode **preview**; a notification offers **Ingest to Statewave**. Nothing sent yet.
7. Click **Ingest to Statewave**.
   - [ ] **Expected:** progress notification; status bar transitions `syncing → compile pending → compiling → ready`. Output: `ingested N/N`, then a scheduled compile line.
8. Run **Statewave: Open Project Understanding**.
   - [ ] **Expected:** webview with sections + "Generated from" provenance; no scripts; theme-correct. *(screenshot #3 here)*
9. Run **Statewave: Diagnose**.
   - [ ] **Expected:** report with `[ok]` lines for server/auth/subject/MCP; "Copy report" works.
10. Run **Statewave: Reset Local Integration** → confirm.
    - [ ] **Expected:** modal; on confirm, Output lists removed MCP entries + instruction files/blocks; cache cleared. Re-open a file with your own `CLAUDE.md`/`.github/copilot-instructions.md` content — **STOP** if any of *your* content was removed (only the `<!-- statewave:* -->` block should be gone).

## B. Edge behavior (still in dev host)

11. Set `statewave.url` to a dead URL (`http://localhost:9`). Run Build → Ingest.
    - [ ] **Expected:** status bar "offline"/error; clear error toast; **no unhandled exception**; preview still worked.
12. Set a valid URL but wrong `statewave.apiKey`. Run **Diagnose**.
    - [ ] **Expected:** Diagnose flags `401` with the fix.
13. Reload the dev host with the test repo **untrusted** (Restricted Mode).
    - [ ] **Expected:** Output says workspace not trusted; **no** MCP wiring / instruction files / watcher. Trust it → behavior applies, no reload needed. **STOP** if anything was wired while untrusted.

## C. VSIX in real VS Code (clean profile)

14. `pnpm --filter statewave-ide-companion package` → `code --profile sw-smoke --install-extension packages/vscode-extension/statewave-ide-companion.vsix`
    - [ ] **Expected:** installs; on opening the test repo, activates < ~1s; status bar appears; no errors.
15. Open **Copilot Chat → Agent mode**. Type: `#` (tools) or check available tools.
    - [ ] **Expected:** `statewave_*` MCP tools are listed (VS Code ≥ 1.101). Output had `registered in-memory VS Code provider`.
16. Ask Copilot (agent): *"Use the Statewave memory for this repo — what are its conventions and recent changes?"*
    - [ ] **Expected:** it calls `statewave_get_context` and answers from memory (run Build→Ingest first if empty). *(GIF step 5)*

## D. Cursor

17. `cursor --install-extension packages/vscode-extension/statewave-ide-companion.vsix` (or Install from VSIX in the UI). Open the test repo.
    - [ ] **Expected:** status bar appears; Output shows wiring. Check `~/.cursor/mcp.json` → it has a `statewave` server; **any pre-existing servers are untouched**. **STOP** if other servers were modified.
18. In Cursor chat (agent), ask the same prompt as step 16.
    - [ ] **Expected:** Cursor invokes the `statewave` MCP tool and answers from memory.
19. Confirm only the relevant instruction files exist in the test repo (e.g. `.github/copilot-instructions.md`, `.cursor/rules/statewave.mdc`) — **not** clients you don't run.
    - [ ] **Expected:** detection-gated; no `.windsurf/`, `.roo/`, etc. unless those are installed.

## E. Capture assets (see MARKETPLACE_ASSETS.md)

- [ ] Screenshot 1: status bar + menu (step 3).
- [ ] Screenshot 2: Build preview + Ingest prompt (step 6).
- [ ] Screenshot 3: Project Understanding webview (step 8).
- [ ] 60-sec GIF: steps 1 → 4 → 6/7 → 16 → 8.

## Sign-off

- [ ] All boxes ticked, zero STOPs, in **both** VS Code and Cursor.
- [ ] `git status` clean (no `.vsix`, no `icon.png`, no test-repo paths committed).
- [ ] Then, and only then: generate the icon, push the branch, open the PR.
