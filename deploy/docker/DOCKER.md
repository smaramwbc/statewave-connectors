# Statewave Connectors Runner

The hosted runner for [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) — one process, one TOML config file, every connector in your config running on schedule plus every push receiver multiplexed under one HTTP server with `/healthz`, `/readyz`, and Prometheus `/metrics`.

## Quick start

```bash
docker run --rm \
  -p 3000:3000 \
  -v $PWD/statewave-connectors.toml:/config/statewave-connectors.toml:ro \
  -v statewave-state:/state \
  -e STATEWAVE_URL=https://api.example.com \
  -e STATEWAVE_API_KEY=… \
  -e GITHUB_TOKEN=… \
  statewavedev/statewave-connectors-runner:latest
```

The image expects the config at `/config/statewave-connectors.toml` (set via `STATEWAVE_CONNECTORS_CONFIG` env var inside the image). Mount your TOML file there read-only.

If your config uses `[runner.state] kind = "file"`, mount a writable volume at `/state` so cursor state survives container restart. The recommended config path is `/state/cursors.json`:

```toml
[runner.state]
kind = "file"
path = "/state/cursors.json"
```

## What's bundled

The image is built on `node:22-alpine` and bundles:

- `@statewavedev/connectors-cli` (which depends on every published connector + the runner)
- `pg` (so `[runner.state] kind = "postgres"` works without a custom rebuild)
- `ioredis` (so `[runner.state] kind = "redis"` works without a custom rebuild)
- `tini` as PID 1 for clean SIGTERM handling

Image runs as a non-root user (`statewave`).

## Tags

| Tag | What |
|---|---|
| `latest` | Most recent build from `main` |
| `<version>` | Pinned to a specific runner / CLI release (e.g. `0.16.0`) |
| `<major>.<minor>` | Floating to the latest patch within a minor (e.g. `0.16`) |
| `sha-<short>` | Specific commit |

Available on Docker Hub (`statewavedev/statewave-connectors-runner`) and GHCR (`ghcr.io/smaramwbc/statewave-connectors-runner`). All images are multi-arch (`linux/amd64`, `linux/arm64`) and ship build provenance + SBOM via Sigstore.

## Pinning to a specific CLI version

The image installs the CLI from npm at build time. To pin a specific version (e.g. for a reproducible build), override the `CLI_VERSION` build arg:

```bash
docker build \
  --build-arg CLI_VERSION=0.1.0 \
  -t my-runner:pinned \
  https://github.com/smaramwbc/statewave-connectors.git#main:deploy/docker
```

## Health probes

| Path | Expected | Use |
|---|---|---|
| `/healthz` | 200 | Liveness — server is alive |
| `/readyz` | 200 between start and stop, 503 outside | Readiness — orchestrators stop sending traffic when 503 |
| `/metrics` | 200 (prom format), optionally auth-gated | Prometheus scrape |

Health endpoints are unauthenticated; `/metrics` accepts optional bearer or basic auth — see the runner README for the schema.

## Source

Dockerfile lives at <https://github.com/smaramwbc/statewave-connectors/blob/main/deploy/docker/Dockerfile>. License: Apache-2.0.
