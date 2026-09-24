---
"@statewavedev/mcp-server": patch
---

Report the real package version instead of a hardcoded `0.1.0`. The version is now read from `package.json` at runtime, so `--version`, `--list-tools` and the `serverInfo.version` returned by the MCP `initialize` handshake all match the published package.
