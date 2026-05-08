# Example — docs and decision memory

This example shows how to turn a folder of Markdown docs — including ADRs, RFCs, and architecture notes — into Statewave episodes so an agent can answer *"what decisions have we made about authentication?"* by recalling the actual decision documents instead of regenerating an opinion.

## What you'll do

1. Dry-run the Markdown connector against your `docs/` folder to preview which files become which kinds of episodes.
2. Ingest for real.
3. Ask your agent a decision question and let it retrieve compact context.

## Prerequisites

- Node 20+
- `pnpm install && pnpm build` from the repo root
- A running Statewave instance

## Steps

```sh
export STATEWAVE_URL=http://localhost:8000
export STATEWAVE_API_KEY=...

# 1. Preview
statewave-connectors sync markdown \
  --path ./docs \
  --subject repo:smaramwbc/statewave \
  --dry-run

# 2. Ingest
statewave-connectors sync markdown \
  --path ./docs \
  --subject repo:smaramwbc/statewave
```

## What gets mapped

The connector recursively scans `.md` and `.mdx` files (skipping `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`).

It detects **decision-style** documents from path/filename:

- Anything under an `adrs/` folder, or a filename like `ADR-0042-licensing.md` → kind `docs.adr`
- Anything under `rfcs/` or filenames matching the RFC pattern → kind `docs.rfc`
- Filenames containing `decision` or paths under `architecture/` → kind `docs.decision`
- Everything else → kind `docs.page`

YAML frontmatter (when present) is parsed into `metadata.frontmatter`, and the H1 of the body is used as the title (overridden by `title:` in frontmatter).

## Idempotency

Each episode's `idempotency_key` is derived from the file's path **and** content hash. Editing a doc produces a new episode (the prior version remains in your timeline). Re-syncing without changes is a no-op.

## Subject

We recommend `repo:<owner>/<name>` for repository-scoped decision memory, so an agent asking *"what was decided about X in repo Y?"* picks up the right context.

For org-wide decisions that don't belong to a single repo, use `workspace:<your-workspace>` instead.
