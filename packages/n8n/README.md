# @statewavedev/connectors-n8n

n8n connector for Statewave — turns workflow executions, failures, and per-node errors into normalized episodes under `workflow:<id>`.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source event | Episode `kind` |
|---|---|
| Successful workflow run | `n8n.workflow.executed` |
| Failed / crashed workflow run | `n8n.workflow.failed` |
| Errored node (one per failed node within a failed run) | `n8n.node.errored` |

Pull-mode against your n8n instance's REST API (`GET /api/v1/executions?includeData=true`). Per-node errors are extracted from the execution's `runData` blob without an extra round-trip.

## Quickstart

```bash
export N8N_API_KEY=...
statewave-connectors sync n8n \
  --workflows "Daily ETL,42" \
  --instance-url https://n8n.example.com \
  --since 2026-01-01 \
  --dry-run
```

`--workflows` accepts ids (visible in the n8n URL) or names. At least one is required so you don't accidentally walk every execution in the instance on first run.

## Options

```
--workflows LIST      comma-separated ids or names (required)
--instance-url URL    base URL of the n8n instance (required, or set N8N_INSTANCE_URL)
--subject SUBJECT     override the default `workflow:<id>` subject
--since YYYY-MM-DD    earliest execution to consider
--max-items N         cap mapped episodes
--include LIST        allow-list: executions, node_errors (default: both)
--exclude LIST        deny-list (e.g. --exclude executions for failure-only ingestion)
--dry-run             preview mapped episodes without ingesting (recommended for new use)
```

## Auth

API key only (read-only). Mint one in the n8n UI: **Settings → API → Create new API key**. The connector reads the key from `N8N_API_KEY` and the instance URL from `N8N_INSTANCE_URL` (or `--instance-url`). The key is sent only as `X-N8N-API-KEY` to your own n8n instance — never anywhere else.

## Status

`v0.1.0` — pull-mode ingestion. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.1 (planned):

- Live ingestion via n8n's webhook node (workflow runs would push to Statewave directly)
- Captured input/output snippets per node, redacted by default
- Per-instance correlation when one connector covers multiple n8n instances
