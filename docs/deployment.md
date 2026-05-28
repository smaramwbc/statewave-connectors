# Deploying the runner

Five ways to run `@statewavedev/connectors-runner`. Every recipe ships in `deploy/` (or `helm/`) with a copy-pasteable example and a one-page README.

| Recipe | When | Difficulty |
|---|---|---|
| [Docker (raw `docker run`)](#docker-raw) | Dev, ad-hoc, "I just want to try it" | 30 seconds |
| [Docker Compose](#docker-compose) | Single-VM production, dev environments with optional Postgres / Redis | 2 minutes |
| [Kubernetes (Helm)](#kubernetes-helm) | Anywhere k8s already runs — most flexible scaling story | 5 minutes |
| [Fly.io](#flyio) | Solo / small-team production, anywhere in the world in one command | 5 minutes |
| [Railway](#railway) | Same idea as Fly — managed-service-first | 5 minutes |

All five use the same image (`statewavedev/statewave-connectors-runner` on Docker Hub, `ghcr.io/smaramwbc/statewave-connectors-runner` on GHCR) and the same TOML config — pick the runtime that matches your team.

## Before you start

Two artifacts every recipe needs:

1. **`statewave-connectors.toml`** — the runner config. Use `[[pull.<kind>]]` and `[[push.<kind>]]` blocks for sources, `${VAR}` for anything secret. Copy `deploy/compose/statewave-connectors.toml.example` as a starting point.
2. **Secrets** — every `${VAR}` reference in the TOML must be supplied as an env var at runtime. Recipes differ in *how* they inject env vars (Compose `.env`, Helm Secret, `fly secrets`, Railway variables) but the principle is identical.

Run `statewave-connectors validate-config --config ./statewave-connectors.toml` before shipping — it catches schema errors, missing `${VAR}`s, and duplicate `name`s in one pass without any network calls.

## Docker (raw)<a id="docker-raw"></a>

```bash
docker run --rm -p 3000:3000 \
  -v $PWD/statewave-connectors.toml:/config/statewave-connectors.toml:ro \
  -v statewave-state:/state \
  -e STATEWAVE_URL=https://api.example.com \
  -e STATEWAVE_API_KEY=… \
  statewavedev/statewave-connectors-runner:latest
```

The image bundles `pg` and `ioredis` so any `[runner.state] kind` works without rebuilding. Mount the TOML read-only at `/config/statewave-connectors.toml`. For file-backed state, mount a writable volume at `/state` and point your config at `/state/cursors.json`.

→ [`deploy/docker/`](../deploy/docker/) — Dockerfile + DOCKER.md

## Docker Compose<a id="docker-compose"></a>

Brings up the runner plus optional Postgres / Redis as Compose profiles:

```bash
cd deploy/compose
cp .env.example .env
cp statewave-connectors.toml.example statewave-connectors.toml
$EDITOR .env statewave-connectors.toml

docker compose up -d                          # file-backed state
docker compose --profile postgres up -d       # with Postgres
docker compose --profile redis up -d          # with Redis
```

The Compose file mounts the state volume + TOML config; healthchecks against `/healthz`. Right for single-VM deployments and dev environments.

→ [`deploy/compose/`](../deploy/compose/) — full README + `.env.example` + TOML example

## Kubernetes (Helm)<a id="kubernetes-helm"></a>

```bash
helm install my-runner ./helm/connectors-runner \
  --namespace statewave \
  --create-namespace \
  -f my-values.yaml
```

The chart materializes a Deployment + Service + ConfigMap + Secret + (opt-in) PVC + (opt-in) Ingress + (opt-in) Prometheus-Operator ServiceMonitor. The Deployment includes `checksum/config` annotations so a config edit triggers a rolling restart.

For multi-replica deployments, switch `[runner.state]` to `postgres` or `redis` — file-backed state is single-process only, and the chart's `NOTES.txt` warns when the settings are out of sync.

For externally-managed secrets (External Secrets Operator, Sealed Secrets, SOPS), set `existingSecret: my-runner-secrets` and leave the inline `secrets:` map empty.

→ [`helm/connectors-runner/`](../helm/connectors-runner/) — chart + README + minimal `values.yaml`

## Fly.io<a id="flyio"></a>

```bash
fly apps create statewave-connectors-runner
fly volumes create state --region iad --size 1
fly secrets set STATEWAVE_URL=… STATEWAVE_API_KEY=…
fly deploy --config deploy/fly/fly.toml
```

A 2-line custom `Dockerfile` (`FROM statewavedev/statewave-connectors-runner:latest` + `COPY statewave-connectors.toml /config/`) bakes your config into the image; `fly deploy` ships it. File-backed state survives restarts via the Fly volume.

→ [`deploy/fly/`](../deploy/fly/) — `fly.toml.example` + README

## Railway<a id="railway"></a>

```bash
railway init --name statewave-connectors-runner
railway variables --set STATEWAVE_URL=… STATEWAVE_API_KEY=…
railway up
```

Same custom-Dockerfile pattern as Fly. For state, either attach a Railway Volume at `/state` (file-backed) or `railway add --plugin postgresql` and use `${DATABASE_URL}` in your TOML.

→ [`deploy/railway/`](../deploy/railway/) — `railway.json.example` + README

## Production checklist

Regardless of runtime:

- **`[runner.state]` is not `memory`** — restarts lose cursor state. Pick `file` (single-process), `postgres`, or `redis`.
- **`[runner.metrics.auth]` is set** when `/metrics` is reachable from outside a trusted network. Three modes: `none` (default), `bearer`, `basic`.
- **Push receivers are TLS-fronted**. The runner speaks plain HTTP; let your reverse proxy / cloud LB / Fly's `force_https` handle TLS.
- **`STATEWAVE_API_KEY`, `*_TOKEN`, `*_SECRET`** all live in the runtime's secret manager (Helm Secret + ESO, `fly secrets`, Railway variables, Compose `.env` not committed). The runner reads them via `${VAR}` interpolation at boot.
- **Backups** — for file-backed state: snapshot the volume on a schedule. For Postgres / Redis: piggyback on whatever you already do for the upstream Statewave server's data.
- **Resource sizing** — the defaults (100m CPU / 128Mi memory) handle low-volume deployments. Scale up for GitHub orgs with thousands of repos, Slack workspaces with hundreds of channels, etc.
- **Health probes** — every recipe wires `/healthz` (liveness) and `/readyz` (readiness). Both unauthenticated.
- **Validate before deploy** — `statewave-connectors validate-config` runs as a static check that doesn't require network access. Add it to CI.

## See also

- [Runner README](../packages/runner/README.md) — full feature surface (schedule syntax, state adapters, OIDC, metrics, graceful shutdown)
- [Config README](../packages/config/README.md) — TOML schema + validation rules
- [Connectors roadmap](roadmap.md) — what's next
