# @statewavedev/mcp-server

## 0.3.0

### Minor Changes

- [#95](https://github.com/smaramwbc/statewave-connectors/pull/95) [`d67f98a`](https://github.com/smaramwbc/statewave-connectors/commit/d67f98ab21a228422d74834cc7f58848f87867bc) Thanks [@smaramwbc](https://github.com/smaramwbc)! - Add the **Streamable HTTP transport** — the Statewave MCP server can now serve remote clients, not just local ones.

  The server previously spoke MCP only over stdio (one child process per client). This adds a second transport: a single stateless JSON-RPC endpoint (`POST /mcp`) reachable over HTTP, so **Claude.ai custom connectors, ChatGPT, hosted agents, and teams pointing many agents at one shared memory** can all use the same five tools. The protocol logic is now shared between both transports (`handleJsonRpcMessage`) so they can't drift.

  Start it with `statewave-connectors mcp start --http` (or `statewave-mcp-server --http`), with `--host` / `--port` / `--path` / `--auth-token`. Safe by default: binds to `127.0.0.1`, validates the `Origin` header against DNS-rebinding, exposes an unauthenticated `/healthz`, and supports an optional bearer token (`--auth-token` / `STATEWAVE_MCP_AUTH_TOKEN`) that must be set before going public. The `initialize` handshake now echoes the client's requested protocol version for broader compatibility.

  Also adds **`mcp init claude-desktop`** — configures the Claude Desktop app's `claude_desktop_config.json` (OS-specific path) and prints the memory guidance to paste into custom instructions, since chat apps have no per-repo instruction file.
