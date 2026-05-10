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
| `/healthz` | 200 once listening | Liveness probe — server is alive, regardless of connector state |
| `/readyz` | 200 between `start()` and `stop()`; 503 outside | Readiness probe — flips to ready after every receiver loaded successfully and every schedule armed |
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

## State today (Wave 2): in-memory only

Per-source pull cursors and per-receiver dedup caches live in memory. **Restart the runner and you lose that state**:

- Pull cursors reset to "cold start" — the next tick will sync from each connector's `since_default` (or whatever the connector's cold-start behaviour is).
- Push receiver dedup caches reset — the first replay of a webhook event after restart will re-ingest, but the upstream system's stable event-id (Slack messageId, Zendesk event_id, Intercom envelope id, Pub/Sub messageId) means the resulting episodes still dedup at the Statewave server's idempotency layer.

Wave 3 ships file / Postgres / Redis adapters using the same `PullCursorStore` interface — a one-line config flip.

## Graceful shutdown

`stop()` (or SIGTERM / SIGINT via the CLI):

1. Flips `/readyz` to 503 so orchestrators stop sending traffic.
2. Stops every schedule (in-flight ticks finish; new ticks won't fire).
3. Closes the HTTP server (Node's `server.close()` waits for in-flight requests to drain).

Both `start()` and `stop()` are idempotent.

## Status

`v0.1.0` — the runner + the `statewave-connectors run` CLI command. State is in-memory; OIDC verification for the Gmail Pub/Sub receiver is still pluggable via `verifyAuth`; Prometheus metrics + Helm chart are in follow-up waves on the operator/cloud track. See [`docs/roadmap.md`](https://github.com/smaramwbc/statewave-connectors/blob/main/docs/roadmap.md) for what's queued next.
