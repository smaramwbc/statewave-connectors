# @statewavedev/connectors-runner

The hosted runner for Statewave connectors. One Node process, one config file, every connector in your config running on schedule + every push receiver mounted under one HTTP server.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem. Consumes [`@statewavedev/connectors-config`](../config/README.md) for the schema and the per-connector packages for the actual sync / receive logic. Driven by `statewave-connectors run` in [`@statewavedev/connectors-cli`](../cli) — but importable directly so anyone can embed the runner in their own service.

## What it does

```
$ statewave-connectors run --config ./statewave-connectors.toml
statewave-connectors run
  config:     ./statewave-connectors.toml  [explicit]
  listening:  http://0.0.0.0:3000
  pull schedules:
    github/main-repo       (every 1h)
    github/second-repo     (0 */6 * * *)
    gmail/founder-inbox    (every 15m)
  push receivers:
    slack/team-events       →  /slack/team-events/events
    gmail/founder-pubsub    →  /gmail/founder-pubsub/events
  health:     /healthz, /readyz
  Ctrl-C to stop.
```

For each tick of a pull source: load cursor → instantiate connector → `connector.sync()` → ingest each episode → persist new cursor.

For each push request: route by URL path → call the receiver factory's handler (signature verification, dedup, retry semantics live inside the receiver) → ingest emitted episodes through the runner's shared sink.

## Public API

```ts
import { createRunner } from '@statewavedev/connectors-runner'
import { loadConfig } from '@statewavedev/connectors-config'

const { config } = await loadConfig({ configPath: './statewave-connectors.toml' })

const runner = await createRunner({ config })
await runner.start()

// SIGTERM / SIGINT / your own cleanup hook:
await runner.stop()
```

`createRunner({ config, ingest?, cursorStore?, logger?, fetchImpl? })` returns a `Runner` with `start()`, `stop()`, and `describe()`. All four overrides are useful for embedding:

| Override | Default | Why override |
|---|---|---|
| `ingest` | HTTP `POST <statewave.url>/v1/episodes` | Embed the runner inside a process that already has its own statewave client |
| `cursorStore` | `InMemoryPullCursorStore` | Persistent state — Wave 3 ships file/Postgres/Redis adapters |
| `logger` | `createLogger({ format })` | Plug a real log shipper (Pino, structlog over JSON-RPC, etc.) |
| `fetchImpl` | `globalThis.fetch` | Polyfill or test stub |

## HTTP surface

| Path | Status | What |
|---|---|---|
| `/healthz` | 200 once listening | Liveness probe — server is alive, regardless of connector state. Always unauthenticated. |
| `/readyz` | 200 between `start()` and `stop()`; 503 outside | Readiness probe — flips to ready after every receiver loaded successfully and every schedule armed. Always unauthenticated. |
| `/metrics` | 200 prom-format; optionally auth-gated | Prometheus scrape endpoint with per-source pull counters, per-receiver push counters, and the prom-client default Node process metrics. See [Metrics](#metrics) below. |
| `/<kind>/<name>/events` | Per-receiver behaviour | Push receiver — one mount per `[[push.<kind>]]` entry in your config |
| anything else | 404 + `{ error: "not_found", hint: "mounted: …" }` | Lists what IS mounted so a misconfigured webhook URL is obvious |

The `/<kind>/<name>/events` paths are derived from the config: `[[push.slack]] name = "team-events"` mounts at `/slack/team-events/events`. This is **different** from the existing `statewave-connectors listen <connector>` daemon (which mounts at `/<kind>/events` because it only handles one receiver at a time). The two daemons are separate — `listen` stays as-is for single-receiver users; `run` is the new multi-instance daemon.

## Schedule strings

Pull-mode entries take a `schedule` string. Two forms accepted:

- **Human shorthand**: `every <N><s|m|h|d>` — e.g. `every 15m`, `every 1h`, `every 30s`
- **Standard cron**: 5- or 6-field POSIX cron — e.g. `0 */6 * * *`, `*/30 * * * * *` (with seconds)

The runner uses `setInterval` for the human form and [`croner`](https://github.com/Hexagon/croner) for cron. Both serialize overlapping ticks: a slow sync doesn't get re-fired while it's still running. Neither form fires on `start()` — the first tick lands one interval out, so a daemon restart doesn't cause a thundering herd of catch-up syncs.

## Multi-instance from day one

```toml
# Two GitHub repos on different schedules — neither blocks the other
[[pull.github]]
name     = "main-repo"
schedule = "every 1h"
repo     = "smaramwbc/statewave"

[[pull.github]]
name     = "connectors-repo"
schedule = "every 6h"
repo     = "smaramwbc/statewave-connectors"

# Prod + sandbox Slack on different paths
[[push.slack]]
name           = "prod"
signing_secret = "${SLACK_PROD_SECRET}"
channels       = ["C0123ABC"]

[[push.slack]]
name           = "sandbox"
signing_secret = "${SLACK_SANDBOX_SECRET}"
channels       = ["C0789XYZ"]
```

The runner uses `(connector_kind, name)` to key cursor state and to mount push receivers, so two `[[pull.github]]` blocks don't trample each other and `/slack/prod/events` and `/slack/sandbox/events` route to two different handlers.

## Persistent state (Wave 3)

Per-source pull cursors persist across restarts via a `[runner.state]` block in the config. Four kinds available — pick the one that fits your deployment:

```toml
# Single-process daemon, simplest deploy:
[runner.state]
kind = "file"
path = "./var/connectors-state/cursors.json"   # default: <state_dir>/cursors.json

# Multi-process behind a load balancer, sharing one DB:
[runner.state]
kind  = "postgres"
url   = "${STATEWAVE_DB_URL}"
table = "statewave_runner_cursors"             # default

# Multi-process behind a load balancer, Redis-backed:
[runner.state]
kind        = "redis"
url         = "${REDIS_URL}"
key_prefix  = "statewave_runner:"              # default; hash key is <prefix>cursors

# Default — lost on restart, fine for dev / tests / ephemeral pods:
[runner.state]
kind = "memory"
```

Omitting `[runner.state]` defaults to `memory`.

**File adapter**: atomic JSON-file write (write-tmp → fsync → rename). Concurrent ticks are serialized through a write queue so no in-flight write can clobber another. Versioned on-disk format (refuses to overwrite a file with an unknown version, so future migrations are tractable). One file = one runner process — multi-process operators must use Postgres or Redis instead.

**Postgres adapter**: single table (`CREATE TABLE IF NOT EXISTS …` runs idempotently on every boot). `INSERT … ON CONFLICT (kind, name) DO UPDATE` for `set()`. Reuses the Statewave server's database or a dedicated one.

**Redis adapter**: single hash at `<prefix>cursors`, one field per `kind/name`. `HGET` for reads, `HSET` for writes — single round-trip, atomic.

**Optional peer dependencies**: `pg` and `ioredis` are NOT installed automatically. Operators only install what they need:

```bash
npm install @statewavedev/connectors-runner       # always
npm install pg                                    # only if state.kind = "postgres"
npm install ioredis                               # only if state.kind = "redis"
```

The runner dynamically imports the driver only when the configured kind needs it; missing-driver errors carry an explicit install hint.

**Embedders** can construct the right adapter directly:

```ts
import {
  openFileBackedPullCursorStore,
  openPostgresPullCursorStore,
  openRedisPullCursorStore,
  selectPullCursorStore,
} from '@statewavedev/connectors-runner'

// Either: pick from config
const cursorStore = await selectPullCursorStore({ runner: config.runner })

// Or: instantiate directly (skip the [runner.state] block entirely)
const cursorStore = await openPostgresPullCursorStore({
  url: process.env.DATABASE_URL!,
  table: 'my_cursors',
})

const runner = await createRunner({ config, cursorStore })
```

The Postgres + Redis adapters also accept an injected `pool` / `client` (skip the dynamic driver import) — useful for embedders who already own a connection pool.

### Push receiver dedup caches

Push receiver dedup caches (Slack messageId, Freshdesk event_id, Zendesk event_id, Intercom envelope id, Pub/Sub messageId) are still in-memory in this release. The upstream system's stable event-id means the Statewave server's idempotency layer absorbs any duplicates that slip through after a restart, so the operational impact is bounded — but persistent dedup caches are queued for a follow-up.

## Metrics

Prometheus scrape endpoint at `/metrics` (path overridable via `[runner.metrics].path`). One scrape returns:

| Series | Type | Labels | What |
|---|---|---|---|
| `statewave_runner_pull_ticks_total` | counter | `kind`, `name` | Pull-source schedule ticks fired (success + failure). |
| `statewave_runner_pull_episodes_emitted_total` | counter | `kind`, `name` | Episodes returned by `connector.sync()`. |
| `statewave_runner_pull_episodes_ingested_total` | counter | `kind`, `name` | Episodes successfully posted to Statewave. Excludes `dry_run` ticks. |
| `statewave_runner_pull_errors_total` | counter | `kind`, `name`, `reason` (`load` / `sync` / `ingest`) | Pull-source failure budget — alert on rate-of-change. |
| `statewave_runner_pull_last_sync_timestamp_seconds` | gauge | `kind`, `name` | Unix timestamp of the most recent successful sync. Pair with `time() - … > N` alerts to catch dead schedules. |
| `statewave_runner_pull_sync_duration_seconds` | histogram | `kind`, `name` | `connector.sync()` wall-clock time. Buckets: 0.5 / 1 / 2.5 / 5 / 10 / 30 / 60 / 120 / 300 s. |
| `statewave_runner_push_deliveries_total` | counter | `kind`, `name` | HTTP requests received by each push receiver. |
| `statewave_runner_push_responses_total` | counter | `kind`, `name`, `status` | Push responses by HTTP status — `status="401"` for signature failures, `status="200"` for success / dedup hits. |
| `statewave_runner_push_handler_errors_total` | counter | `kind`, `name` | Times a receiver's handler threw an exception. |
| `statewave_runner_push_delivery_duration_seconds` | histogram | `kind`, `name` | Wall-clock time per delivery. Buckets: 5ms / 10ms / 25ms / 50ms / 100ms / 250ms / 500ms / 1s / 2.5s / 5s / 10s. |
| `statewave_runner_info` | gauge | `version`, `hostname` | Static metadata, always 1. |
| `statewave_runner_schedules_armed` | gauge | — | Number of pull schedules currently armed. |
| `statewave_runner_push_receivers_mounted` | gauge | — | Number of push receivers mounted. |
| `statewave_runner_ready` | gauge | — | 1 between `start()` and `stop()`, 0 otherwise. |

Plus the [prom-client default Node process metrics](https://github.com/siimon/prom-client#default-metrics) (CPU, memory, GC, event-loop lag, file descriptors). Disable with `disableDefaultMetrics: true` on `createRunner` if you don't want them.

### Auth on `/metrics`

`/metrics` is sensitive in public deployments — series labels can leak source names, ingest volumes, error rates. Three auth modes available:

```toml
# Default — no auth. Right for trusted networks (k8s service mesh, internal VPC).
# (Omit [runner.metrics] entirely for the same effect.)
[runner.metrics]
auth = { kind = "none" }

# Bearer token — pass `Authorization: Bearer <token>` to scrape.
[runner.metrics.auth]
kind  = "bearer"
token = "${STATEWAVE_METRICS_TOKEN}"

# HTTP Basic — pass `Authorization: Basic <base64(user:pass)>`.
[runner.metrics.auth]
kind     = "basic"
username = "${STATEWAVE_METRICS_USER}"
password = "${STATEWAVE_METRICS_PASSWORD}"
```

Compares are constant-time. The 401 response carries `WWW-Authenticate: Basic realm="metrics", Bearer` so curl + browsers know how to retry — but doesn't disclose which mode is configured (small fingerprinting win).

**`/healthz` and `/readyz` stay unauthenticated regardless** — orchestrators may not have credentials, and exposing them is the whole point of a probe.

### Prometheus scrape config

```yaml
scrape_configs:
  - job_name: statewave-connectors
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: ${STATEWAVE_METRICS_TOKEN}
    static_configs:
      - targets: ['statewave-runner.svc.cluster.local:3000']
```

### Recommended alerts

```yaml
# Pull schedule has gone silent for over 30 minutes.
- alert: StatewaveConnectorsPullStale
  expr: time() - statewave_runner_pull_last_sync_timestamp_seconds > 1800
  for: 5m
  labels: { severity: warning }
  annotations:
    summary: "Pull source {{ $labels.kind }}/{{ $labels.name }} hasn't synced in 30+ min"

# Sustained sync failures.
- alert: StatewaveConnectorsPullErrors
  expr: rate(statewave_runner_pull_errors_total[15m]) > 0.1
  for: 10m
  labels: { severity: warning }

# Push receiver has been off (no deliveries in 6h on a busy webhook).
- alert: StatewaveConnectorsPushIdle
  expr: rate(statewave_runner_push_deliveries_total[6h]) == 0
  for: 1h
  labels: { severity: info }

# Runner failed its readiness probe.
- alert: StatewaveConnectorsNotReady
  expr: statewave_runner_ready == 0
  for: 5m
  labels: { severity: critical }
```

## Graceful shutdown

`stop()` (or SIGTERM / SIGINT via the CLI):

1. Flips `/readyz` to 503 so orchestrators stop sending traffic.
2. Stops every schedule (in-flight ticks finish; new ticks won't fire).
3. Closes the HTTP server (Node's `server.close()` waits for in-flight requests to drain).

Both `start()` and `stop()` are idempotent.

## Status

`v0.3.0` — the runner + `statewave-connectors run`; persistent pull-cursor state adapters (file / Postgres / Redis via `[runner.state]`); built-in OIDC verification for Gmail Pub/Sub; auth-gated Prometheus `/metrics`; deployment recipes incl. the Helm chart (`helm/connectors-runner/`). Push-receiver dedup caches remain in-memory (see above). See [`docs/roadmap.md`](https://github.com/smaramwbc/statewave-connectors/blob/main/docs/roadmap.md) for what is queued next.
