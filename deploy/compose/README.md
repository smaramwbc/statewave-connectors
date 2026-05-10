# Docker Compose recipe

Single-host deployment of the connectors runner using Docker Compose. Right for development, single-VM deploys, and small production setups that don't need multi-instance scaling.

## Quick start

```bash
# 1. Copy the templates and fill them in.
cd deploy/compose
cp .env.example .env
cp statewave-connectors.toml.example statewave-connectors.toml
$EDITOR .env statewave-connectors.toml

# 2. Bring up the runner.
docker compose up -d

# 3. Tail logs.
docker compose logs -f runner

# 4. Verify.
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
curl -H "Authorization: Bearer $STATEWAVE_METRICS_TOKEN" http://localhost:3000/metrics
```

## Layout

- `docker-compose.yml` — runner + optional Postgres + optional Redis, gated by Compose profiles
- `.env.example` → copy to `.env`; supplies env-var values referenced by `${VAR}` in the TOML
- `statewave-connectors.toml.example` → copy to `statewave-connectors.toml`; the runner config
- `README.md` — this file

## Optional services

The Postgres and Redis services live behind Compose profiles, so they only start when you opt in:

```bash
# File-backed state (default — no extra services needed):
docker compose up -d

# Postgres state:
docker compose --profile postgres up -d

# Redis state:
docker compose --profile redis up -d
```

For Postgres / Redis state, also uncomment the matching `[runner.state]` block in your TOML.

## Updating

The image installs the **latest** published runner CLI on every build. Pull a fresh image to upgrade:

```bash
docker compose pull
docker compose up -d
```

To pin a specific version, use a versioned tag in the compose file (`statewavedev/statewave-connectors-runner:0.16.0` instead of `:latest`).

## Production checklist

- [ ] `.env` is **not** committed (already covered by `.gitignore` if you put this in your own repo)
- [ ] `STATEWAVE_METRICS_TOKEN` is a long random string (use `openssl rand -hex 32`)
- [ ] `[runner.state] kind` is `file` (with persistent volume), `postgres`, or `redis` — not `memory` in production
- [ ] Push receivers (Slack, Freshdesk, Zendesk, Intercom, Gmail) are exposed via a reverse proxy with TLS — the runner itself speaks HTTP only
- [ ] Backups for the state store: snapshot the `state` volume / Postgres database / Redis dump on a schedule
