# @statewavedev/statewave

Production-grade memory layer for AI agents — one command to install, configure, and run.

> `npx @statewavedev/statewave` is the fastest way to get Statewave running locally. It boots the API, admin console, and database via Docker Compose, wires MCP into your coding assistants, and seeds your repo — self-hosted, offline, no account required.

## Usage

```bash
npx @statewavedev/statewave
```

That's it. The quickstart:

1. Detects your MCP clients (Claude Code, Claude Desktop, Cursor, VS Code Copilot, Codex CLI, and more)
2. Starts the Statewave stack via Docker Compose (API on `:8100`, admin on `:8080`)
3. Optionally connects an LLM provider for richer memory compilation
4. Seeds the current repo into memory

**Tear down:**

```bash
npx @statewavedev/statewave --down
```

**Point at an existing server:**

```bash
npx @statewavedev/statewave --statewave-url http://your-server:8100
```

All flags are forwarded to the underlying [`@statewavedev/connectors-cli`](https://www.npmjs.com/package/@statewavedev/connectors-cli) `quickstart` command.

## What Statewave is

Statewave is a memory backend for AI agents with governance built in from day one:

- **Sensitivity labels** — classify memories at ingest; enforce in retrieval
- **Declarative policies** — define what can be stored, accessed, and for how long
- **Tamper-evident audit receipts** — every write produces a verifiable provenance record
- **Multi-tenant isolation** — subjects are fully isolated at the storage layer
- **GDPR erasure** — delete a subject and its compiled memories in one call
- **State-assembly receipts** — every context response traces to its source episodes

Memory is not just retrieval. Statewave ships the governance layer most teams build too late.

## Requirements

- Node.js ≥ 20
- Docker (for the quickstart stack)

## Links

- [statewave.ai](https://statewave.ai)
- [Documentation](https://github.com/smaramwbc/statewave-docs)
- [GitHub](https://github.com/smaramwbc/statewave)
- [Release notes](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md)

## License

Apache-2.0
