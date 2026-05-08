# Statewave MCP server

Stdio MCP (Model Context Protocol) server that exposes Statewave memory tools to MCP-compatible clients (Claude Desktop, Cursor, Continue, …).

[![Image](https://img.shields.io/docker/image-size/statewavedev/statewave-mcp-server/latest?label=image)](https://hub.docker.com/r/statewavedev/statewave-mcp-server)
[![Pulls](https://img.shields.io/docker/pulls/statewavedev/statewave-mcp-server)](https://hub.docker.com/r/statewavedev/statewave-mcp-server)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/smaramwbc/statewave-connectors/blob/main/LICENSE)

Multi-arch (`linux/amd64`, `linux/arm64`), built with provenance + SBOM and signed via Sigstore. Runs as non-root.

## Try it

```sh
docker run --rm statewavedev/statewave-mcp-server:latest --help
docker run --rm \
  -e STATEWAVE_URL=https://your-statewave-instance \
  -e STATEWAVE_API_KEY=sk-... \
  statewavedev/statewave-mcp-server:latest --list-tools
```

## Wire it into Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "statewave": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "STATEWAVE_URL",
        "-e", "STATEWAVE_API_KEY",
        "statewavedev/statewave-mcp-server:latest"
      ],
      "env": {
        "STATEWAVE_URL": "https://your-statewave-instance",
        "STATEWAVE_API_KEY": "sk-..."
      }
    }
  }
}
```

## Tags

| Tag | Meaning |
|---|---|
| `latest` | Tip of `main` |
| `X.Y.Z` | Semver release of `@statewavedev/mcp-server` |
| `X.Y`, `X` | Latest in the minor / major line |
| `sha-<7>` | Specific commit |

## Verify the build attestation

```sh
gh attestation verify \
  oci://docker.io/statewavedev/statewave-mcp-server:latest \
  --owner smaramwbc
```

## Source & docs

- Repository: <https://github.com/smaramwbc/statewave-connectors>
- Package: `@statewavedev/mcp-server` on npm
- Documentation: <https://statewave.ai>
- License: Apache-2.0
