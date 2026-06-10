# Example — agent memory via MCP

This example shows how to expose Statewave memory to any MCP-compatible client (coding agents, assistant tools, custom agents). The MCP server is vendor-neutral — it does not assume any specific IDE or model provider.

## What you'll do

1. Start a Statewave instance.
2. Start the Statewave MCP server.
3. Point an MCP-compatible client at it.
4. Ask the client a question that requires repo memory; the client calls `statewave_get_context` and gets back compact, ranked context.

## Prerequisites

- Node 20+
- `pnpm install && pnpm build` from the repo root
- A running Statewave instance with some episodes already ingested (see the [GitHub example](../github-repo-memory/README.md))

## Steps

### 1. Start Statewave

See the main `statewave` repo for `docker compose up` or your preferred runtime.

### 2. Start the MCP server

```sh
export STATEWAVE_URL=http://localhost:8100
export STATEWAVE_API_KEY=...

statewave-connectors mcp start
```

> The MCP server ships the five canonical tool definitions (`statewave_ingest_episode`, `statewave_search_memories`, `statewave_get_context`, `statewave_get_timeline`, `statewave_compile_subject`), an input-validating dispatcher, and a bundled stdio JSON-RPC 2.0 transport. You can inspect the tool surface programmatically:

```ts
import { listTools } from "@statewavedev/mcp-server";
console.log(listTools());
```

### 3. Connect a client

The Statewave MCP server is intentionally vendor-neutral. Any client that speaks MCP — whether it ships with a coding assistant, an IDE, or your own agent loop — should be able to call the tools above. Configure the client to launch `statewave-connectors mcp start` (stdio); an HTTP transport is planned.

### 4. Ask a question

Once the agent is connected, ask something it would otherwise have no way to know:

> "What's currently blocking on smaramwbc/statewave?"

The agent calls `statewave_get_context` with `subject=repo:smaramwbc/statewave`. Statewave returns a compact, ranked context window — not raw chat history, not a full RAG index — and the agent answers from it.

## What this is NOT

- It is not a hosted dependency. The MCP server runs where you run it.
- It is not tied to any single IDE or model. The tool surface is the contract; clients vary.
- It is not a replacement for ingestion. You still need to feed Statewave with at least one connector (GitHub, Markdown, etc.) for there to be anything to retrieve.
