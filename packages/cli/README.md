# @statewavedev/connectors-cli

The `statewave-connectors` CLI — feed real-world events into Statewave from your terminal.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## Quick reference

```bash
statewave-connectors doctor
statewave-connectors sync github   --repo OWNER/NAME --subject repo:OWNER/NAME --dry-run
statewave-connectors sync markdown --path ./docs     --subject repo:OWNER/NAME --dry-run
statewave-connectors mcp start [--list-tools]
```

Run `statewave-connectors --help` (or `statewave-connectors <cmd> --help`) for full usage.

## Environment

| Variable | Purpose |
|---|---|
| `STATEWAVE_URL` | Base URL of your Statewave instance. **Required** for ingestion (the CLI refuses to ingest without it). |
| `STATEWAVE_API_KEY` | Optional — only required if your instance enforces auth. |
| `STATEWAVE_TENANT_ID` | Optional — only for multi-tenant deployments. |
| `GITHUB_TOKEN` | Only used by the GitHub connector. |

## Dry-run first

Every connector supports `--dry-run`. The CLI runs the read path and the mapper, prints the resulting episodes, and **does not** call the Statewave ingest API. That's the recommended first run.

## Status

`v0.1.0` preview. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).
