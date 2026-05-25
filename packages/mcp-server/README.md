# @statewavedev/mcp-server

Statewave MCP server — exposes Statewave memory to MCP-compatible clients (coding assistants, agent frameworks, IDE extensions).

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem. Vendor-neutral by design — no IDE, model provider, or hosted dependency assumptions.

## What's here

- **`STATEWAVE_MCP_TOOLS`** — the canonical tool surface (5 tools, JSON Schema input)
- **`StatewaveClient`** — thin HTTP client for the Statewave v1 API (auth, tenant, typed errors)
- **`dispatchTool`** — input-validating dispatcher that maps a tool call to a `StatewaveClient` method
- **`startMcpServer`** — minimal stdio JSON-RPC 2.0 transport, plus a `--list-tools` mode

## Tools

| Tool | Purpose |
|---|---|
| `statewave_ingest_episode` | Ingest a single normalized episode (deduped on `idempotency_key`). |
| `statewave_search_memories` | Search compiled memories by free-text query within a subject. |
| `statewave_get_context` | Retrieve compact, ranked context for a subject — the default tool to use inside a prompt. |
| `statewave_get_timeline` | Chronological episodes for a subject; filterable by `kinds`, `since`, `until`. |
| `statewave_compile_subject` | Trigger compilation of a subject so newly ingested episodes become recallable. |

## Usage

```bash
# As a CLI subcommand (via @statewavedev/connectors-cli)
statewave-connectors mcp start --list-tools     # print the JSON Schema surface and exit
statewave-connectors mcp start                  # stdio JSON-RPC 2.0 server (requires STATEWAVE_URL)

# Or programmatically inside an existing MCP runtime
import { StatewaveClient, dispatchTool } from "@statewavedev/mcp-server";
const client = new StatewaveClient({ url: process.env.STATEWAVE_URL!, apiKey: process.env.STATEWAVE_API_KEY });
const { result } = await dispatchTool(client, "statewave_get_context", {
  subject: "repo:owner/name",
  query: "repo conventions and recent changes",
});
```

## Status

`v0.1.0` preview — minimal stdio transport included. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).
