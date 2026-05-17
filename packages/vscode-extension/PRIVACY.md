# Privacy statement — Statewave IDE Companion

**Plain version: the extension never reads your assistant chat, never sends
telemetry, and only talks to the Statewave server you configure.**

## What it observes
The workspace file tree (classified, ignore-filtered), README/docs/ADR/RFC
content, git branch/remote/recent history, lightweight code structure
(symbol names/kinds only — never source bodies), editor diagnostics
(messages/locations only), and files you save (only if you enable
`statewave.autoIndex`).

## What it never does
- **Never reads Copilot/Cursor/Claude/etc. chat.** No interception, no
  transcript access. Conversational facts enter memory only because the
  *assistant itself* calls the public `statewave_ingest_episode` MCP tool,
  driven by an opt-out instruction — a visible, approvable model action.
- **Never sends telemetry or phones home.** The only network destination is
  your configured `statewave.url`.
- **Never ingests secrets.** `.env*`, `*.pem`, `*.key`, `id_rsa`,
  `credentials`, keystores, etc. are a hard skip and cannot be opted in via
  `includeGlobs`. `node_modules`, build output, lockfiles are excluded.
- **Never ingests on install/activation.** Preview-first; you press Ingest.
- **No side effects in untrusted workspaces.**

## Where data goes
Episodes are sent only to your `statewave.url`. The API key lives in your
local VS Code settings and, for file-based MCP clients, only in home-dir /
editor-storage config (never the repository). Agent-instruction files
contain no secrets and are meant to be committed.

## Your controls
`statewave.redaction.enabled` (on by default), `statewave.assistantInstructions`
(`read-write`/`read-only`/`off`), `statewave.autoIndex` (off by default),
`statewave.mcp.autoWire` + `statewave.mcp.clients`, `Statewave: Show Indexed
Files`, and `Statewave: Reset Local Integration` to undo everything.
