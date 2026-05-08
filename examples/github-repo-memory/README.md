# Example — GitHub repo memory

This example shows how to feed a GitHub repository's history (issues, PRs, comments, reviews, releases) into Statewave so an agent can answer questions like *"what's the state of issue #42?"* or *"what did we decide about caching last quarter?"* without you having to stuff raw GitHub history into the prompt.

## What you'll do

1. Sync the repo with `--dry-run` first to preview the mapped episodes.
2. Sync for real, which calls the Statewave ingest API.
3. Compile memories for the subject.
4. Retrieve context for a question.

## Prerequisites

- Node 20+
- `pnpm install && pnpm build` from the repo root
- A running Statewave instance (see [statewave-docs](https://github.com/smaramwbc/statewave-docs))
- A `GITHUB_TOKEN` with `repo` (or `public_repo` for public repos) read scope

## Steps

```sh
export STATEWAVE_URL=http://localhost:8000
export STATEWAVE_API_KEY=...
export GITHUB_TOKEN=ghp_...

# 1. Preview — does not ingest
statewave-connectors sync github \
  --repo smaramwbc/statewave \
  --subject repo:smaramwbc/statewave \
  --dry-run

# 2. Ingest for real
statewave-connectors sync github \
  --repo smaramwbc/statewave \
  --subject repo:smaramwbc/statewave

# 3. Compile (via the MCP server, an SDK, or a curl to your Statewave instance)
#    See statewave-docs for the compile API surface.

# 4. Retrieve context
#    Ask your agent: "What's open on smaramwbc/statewave?"
#    The agent calls statewave_get_context with subject=repo:smaramwbc/statewave
#    via the MCP server, and gets back compact, ranked context.
```

## Subject

This example uses `repo:smaramwbc/statewave`. For your own repo, use `repo:<owner>/<name>`.

## Filtering

If you only want PRs and releases:

```sh
statewave-connectors sync github \
  --repo smaramwbc/statewave \
  --subject repo:smaramwbc/statewave \
  --include prs,releases \
  --dry-run
```

## Resuming

Re-running `sync` is safe — every episode has a stable `idempotency_key`, so Statewave deduplicates rather than double-storing. Use `--since 2026-01-01` to limit to recent activity.
