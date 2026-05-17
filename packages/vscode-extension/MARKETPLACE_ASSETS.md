# Marketplace assets — Statewave IDE Companion

Everything a human must produce before `vsce publish`. Code/text is done;
the items here are binary or copy and are intentionally not generated in CI.

## 1. Icon (required by Marketplace)

Source: [`media/icon.svg`](media/icon.svg). The Marketplace needs a **PNG,
128×128, opaque, ≤ ~1 MB**.

```sh
cd packages/vscode-extension
npx --yes svgexport media/icon.svg media/icon.png 128:128
# or: npx --yes @resvg/resvg-js-cli media/icon.svg media/icon.png --width 128 --height 128
```

Then add to `package.json` (do not commit until release if you prefer):

```json
"icon": "media/icon.png"
```

`media/icon.png` is git-ignored as a build artifact; regenerate it in the
release pipeline. Verify it appears via `vsce ls`.

## 2. Screenshots (README + listing)

Capture in a real repo at 2× (retina), PNG, ~1400px wide, light theme:

1. **Status bar + menu** — the `🧠 Statewave: N memories ready` item with the
   action/diagnostics QuickPick open.
2. **Build preview** — the Output channel showing the episode preview with
   the "Ingest to Statewave" prompt (preview-first).
3. **Project Understanding** — the webview with a couple of sections expanded
   and the "Generated from" provenance visible.
4. **Show Indexed Files** — the why-indexed / why-skipped report (show a
   `.env` line marked as a hard skip).
5. **Diagnose** — a report with one `[err]` + its `↳ fix`.
6. **Walkthrough** — the first-run "Get started with Statewave" walkthrough.

Embed 1–3 in `README.md` near the top; keep all six in `media/` (referenced
by absolute repo URLs so they render on the Marketplace).

## 3. 60-second demo GIF (script)

≤ 8 MB, ~1280×720, captured in VS Code with a small real repo:

1. (0–8s) Install the extension → status bar appears; Output: "no data sent
   on activation".
2. (8–16s) First-run walkthrough opens; click through "What / privacy".
3. (16–28s) `Statewave: Show Indexed Files` → scroll to a skipped `.env`
   (hard skip).
4. (28–40s) `Statewave: Build Project Memory` → preview → **Ingest**; status
   bar pending → compiling → **ready**.
5. (40–52s) Copilot/Cursor agent: ask *"use the Statewave memory for this
   repo — what are the conventions?"* → assistant calls `statewave_get_context`.
6. (52–60s) `Statewave: Open Project Understanding` → provenance sections.

Export `media/demo.gif`; link it at the top of `README.md`.

## 4. Recommended short description (≤ 100 chars, Marketplace summary)

> A trustworthy, local project brain for your AI assistant — zero-config MCP, never reads your chat.

## 5. Recommended long description (README lead paragraph)

> **Statewave IDE Companion** gives Copilot, Cursor, Claude Code, Windsurf,
> Cline, Roo and Continue a deterministic, local memory of *this* project —
> structure, docs, git history, code structure, conventions and decisions —
> retrieved on demand over MCP. Zero-config: set one URL and the MCP server
> is wired into whatever assistant you use. Preview-first, privacy-hardened
> (secrets are never indexed), no telemetry, vendor-neutral. It never reads
> your assistant chat; it makes your assistant make fewer mistakes.

## 6. Privacy summary (one-liner for the listing)

> Local-only. Never reads assistant chat. No telemetry. Secrets (`.env`,
> keys, credentials) are never indexed. Nothing is sent until you ask.
> Full statement: [PRIVACY.md](PRIVACY.md).

## 7. Tags / keywords (already in package.json)

`statewave, memory, mcp, copilot, cursor, claude code, windsurf, ai, agents,
project context`. Categories: `AI`, `Machine Learning`, `Other`.

## 8. Launch notes

- Ship with **`preview: true`** — this is a first preview; keep it until the
  manual smoke matrix is green on ≥2 real repos.
- `publisher: statewavedev` must be a registered Marketplace publisher;
  publishing needs a PAT with Marketplace scope. `private: true` is flipped
  to `false` **only in the release pipeline**, never committed to `main`.
- Vendor-neutral framing in copy — name Copilot/Cursor/Claude Code/etc.
  evenly; no "AI magic" claims. Lead with trust + determinism.
- First-week watch: Q&A + issues route to `smaramwbc/statewave`.
