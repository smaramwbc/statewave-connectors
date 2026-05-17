# Security statement — Statewave IDE Companion

## Threat model & posture
- **No secrets in the repository.** MCP config is written only to home-dir
  or editor-storage files (or kept in-memory for the Copilot provider). The
  API key is read from local settings and injected into the spawned MCP
  server's environment — never argv, never a repo file.
- **Hard secret-file exclusion.** `.env*`, private keys, credentials, etc.
  are never indexed and cannot be force-included.
- **Workspace trust honoured.** In untrusted workspaces no MCP wiring,
  instruction writing, or watching occurs.
- **Bundled, minimal supply chain.** The extension is a single esbuild
  bundle plus a bundled stdio MCP server; `vscode` is the only runtime
  external. No dev dependencies ship in the VSIX.
- **No telemetry / no phone-home.** Sole network egress is your
  `statewave.url`.
- **Surgical config edits.** Every config merge touches only our managed
  key/block and never clobbers a file that fails to parse.

## Reporting a vulnerability
Please report security issues privately via
<https://github.com/smaramwbc/statewave/security/advisories/new> (or the
repository's Security tab). Do not open a public issue for vulnerabilities.
We aim to acknowledge within 72 hours.

## Scope
This extension; the Statewave server and connector packages have their own
reporting channels in the [statewave-connectors](https://github.com/smaramwbc/statewave-connectors)
repository.
