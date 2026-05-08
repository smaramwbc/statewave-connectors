# Quickstart — Repo memory in 5 minutes

End-to-end walkthrough of the Statewave Connectors v0.1.0 surface using a tiny self-contained docs tree under [`sample-docs/`](sample-docs/). No real GitHub repo or Statewave instance is required to *see* what episodes a real run would produce.

## What you'll do

1. `doctor` — environment diagnostics (cli + node + env)
2. `sync markdown --dry-run` — turn `sample-docs/` into normalized episodes
3. `sync github --dry-run` — preview a public repo's release history (optional, requires network)
4. `mcp start --list-tools` — print the canonical Statewave MCP tool surface
5. *(optional)* re-run markdown without `--dry-run` to ingest into a real Statewave

## Honest scope

This is a **dry-run-first** demo:

- Steps 1, 2, 4 work fully offline.
- Step 3 hits `api.github.com` for one public repo — no `GITHUB_TOKEN` required.
- Step 5 only runs if you set `STATEWAVE_URL` and explicitly opt in (`INGEST=1`).
- The MCP server in v0.1.0 ships a real `StatewaveClient` and tool dispatcher,
  but the stdio/HTTP transport itself is the next planned release. `mcp start --list-tools` reflects that boundary honestly — it prints the schema and exits.

## Run it

```bash
# from the repo root
pnpm install
pnpm build

# then
./examples/repo-memory-quickstart/run.sh
```

You can override the defaults:

```bash
SUBJECT=repo:my-org/my-repo \
GH_REPO=my-org/my-repo \
./examples/repo-memory-quickstart/run.sh
```

To ingest the sample docs into a running Statewave instance:

```bash
STATEWAVE_URL=http://localhost:8000 \
INGEST=1 \
./examples/repo-memory-quickstart/run.sh
```

## Expected output (excerpt)

```
==> 1. doctor
statewave-connectors doctor — warn
  cli       v0.1.0
  node      v22.x
  platform  darwin-arm64

  [warn] STATEWAVE_URL — not set — sync will require STATEWAVE_URL or non-dry-run will refuse to ingest
  [warn] STATEWAVE_API_KEY — not set — only required if your Statewave instance enforces auth
  …

==> 2. markdown dry-run on sample-docs/
synced markdown (markdown) subject=repo:smaramwbc/statewave-connectors
  episodes=4 ingested=0 skipped=0 dryRun=true
  kinds:
    docs.adr                     2
    docs.decision                1
    docs.page                    1
  details:
    files_scanned                4
    files_mapped                 4
  sample episodes (first 4):
    - docs.adr      adrs/0001-use-statewave-connectors.md   subject=repo:smaramwbc/statewave-connectors
    - docs.adr      adrs/0002-dry-run-first.md              subject=repo:smaramwbc/statewave-connectors
    - docs.decision architecture.md                         subject=repo:smaramwbc/statewave-connectors
    - docs.page     README.md                               subject=repo:smaramwbc/statewave-connectors

  dry-run: nothing was ingested. Re-run without --dry-run to send these
  episodes to the Statewave instance at $STATEWAVE_URL.
```

## What an agent would ask next

Once the markdown episodes are ingested and Statewave compiles the subject, an MCP-connected coding agent could ask:

> *"What decisions did we already make about connectors, docs, and repo memory?"*

It calls `statewave_get_context` with `subject=repo:smaramwbc/statewave-connectors` and gets a compact, ranked context bundle that surfaces the substance of `ADR-0001` and `ADR-0002` — instead of the agent re-deriving an opinion from scratch or stuffing the whole `docs/` folder into the prompt.

For now (v0.1.0) you'd wire that by:

1. Importing `dispatchTool` and `StatewaveClient` from `@statewavedev/mcp-server`.
2. Mounting them inside whichever MCP runtime your client uses (stdio or HTTP).

The standalone `statewave-connectors mcp start` transport lands in the next package release — see [docs/roadmap.md](../../docs/roadmap.md).

## Troubleshooting

| Symptom | What to do |
|---|---|
| `pnpm: command not found` | `corepack enable && corepack prepare pnpm@9 --activate` |
| `dist/` not found | Run `pnpm install && pnpm build` from the repo root |
| GitHub dry-run prints "rate limited" | Set `GITHUB_TOKEN` (any classic token with public repo read works) and re-run |
| `STATEWAVE_URL is not set; refusing to ingest` | Expected — set `STATEWAVE_URL` before passing `INGEST=1` |
| `Statewave endpoint not found` from `mcp start --list-tools` after `STATEWAVE_URL` is set | The list-tools mode does not call Statewave. If you see this it's a bug — please file an issue |
