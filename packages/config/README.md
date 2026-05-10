# @statewavedev/connectors-config

TOML config-file loader + validator for the Statewave connectors runner. Multi-instance per connector kind, env-var interpolation with fail-fast diagnostics, deterministic search order.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem. Used by `@statewavedev/connectors-cli` (the `validate-config` command today, the `run` daemon in a follow-up release) and importable directly by anyone who wants to consume the same schema.

## What it does

```ts
import { loadConfig } from '@statewavedev/connectors-config'

const { config, path, source } = await loadConfig()
// config: typed StatewaveConnectorsConfig — see ./src/schema.ts
// path:   '/etc/statewave/connectors.toml' (or null when rawTomlString is used)
// source: 'explicit' | 'env' | 'cwd' | 'xdg'
```

End to end: resolve where to read from, parse the TOML, walk every string and replace `${VAR}` references against `process.env`, validate the shape, return a typed config OR raise a single `ConfigError` listing **every** problem found in one pass.

## Config file shape

```toml
# Statewave server connection (required).
[statewave]
url       = "${STATEWAVE_URL}"
api_key   = "${STATEWAVE_API_KEY}"
tenant_id = "${STATEWAVE_TENANT_ID}"

# Runner-level operational settings (all optional).
[runner]
port       = 3000
host       = "0.0.0.0"
state_dir  = "./var/connectors-state"
log_format = "json"   # or "text"

# ── Pull-mode sources (multi-instance, one entry per `[[pull.<kind>]]`) ──
[[pull.github]]
name          = "main-repo"
schedule      = "every 1h"      # or 5-field cron: "0 */1 * * *"
repo          = "smaramwbc/statewave"
subject       = "repo:smaramwbc/statewave"
token         = "${GITHUB_TOKEN}"

[[pull.github]]
name     = "second-repo"
schedule = "0 */6 * * *"
repo     = "smaramwbc/statewave-connectors"
token    = "${GITHUB_TOKEN}"

[[pull.gmail]]
name          = "founder-inbox"
schedule      = "every 15m"
client_id     = "${GMAIL_CLIENT_ID}"
client_secret = "${GMAIL_CLIENT_SECRET}"
refresh_token = "${GMAIL_REFRESH_TOKEN}"
query         = "label:inbox"

# ── Push-mode receivers (mounted at /<kind>/<name>/events) ──
[[push.slack]]
name           = "team-events"
signing_secret = "${SLACK_SIGNING_SECRET}"
channels       = ["C0123ABC", "C0456DEF"]

[[push.gmail]]
name          = "founder-pubsub"
path_token    = "${GMAIL_PUBSUB_TOKEN}"
client_id     = "${GMAIL_CLIENT_ID}"
client_secret = "${GMAIL_CLIENT_SECRET}"
refresh_token = "${GMAIL_REFRESH_TOKEN}"
query         = "label:inbox"
```

### Multi-instance from day one

Every connector kind is an array (`[[pull.github]]`, `[[push.slack]]`). Real adopters always have *some* second instance: two GitHub orgs, two Slack workspaces (prod + sandbox), two Zendesk subdomains (per region or per brand), an agency operating multiple clients. Single-instance would push them off the runner entirely.

Each entry must carry a `name` matching `[a-z0-9][a-z0-9_-]*` that is unique within its kind. The runner uses `(connector_kind, name)` to:

- Key cursors and dedup state so two `[[pull.github]]` blocks don't trample each other
- Mount push receivers at `/<connector>/<name>/events` (e.g. `/slack/team-events/events`)

The same `name` is allowed across different kinds (`pull.github.primary` and `pull.markdown.primary` don't collide).

## Env-var interpolation

Every string field — anywhere in the tree — is walked and `${VAR}` references are replaced against `process.env` (or an injected env, for tests).

| Syntax | Meaning |
|---|---|
| `${VAR}` | Required. Missing or empty → reported as `missing_env`. |
| `${VAR:-fallback}` | Optional. Uses the fallback when `VAR` is unset OR empty string. |
| `$$` | Escapes a literal `$` (so `$${LITERAL}` renders as `${LITERAL}`). |

Missing-required vars are collected across the whole tree and reported as a single `ConfigError({ code: 'missing_env', missing: [...] })` — the operator sees the full list at once instead of edit-run-edit-run.

Command substitution (`$(...)`) is **not** supported. Secrets stay in env; no eval surface.

## Search order

`loadConfig()` resolves the file path in this order, first match wins:

1. `--config <path>` (caller passes `configPath` to `loadConfig`)
2. `$STATEWAVE_CONNECTORS_CONFIG`
3. `./statewave-connectors.toml` (cwd)
4. `$XDG_CONFIG_HOME/statewave-connectors/config.toml` (defaults to `~/.config`)

`loadConfig({ rawTomlString: '...' })` skips file I/O entirely — useful for tests and embedded use.

## Error model

A single `ConfigError` class with a typed `code` field tells the caller what went wrong:

| `code` | When |
|---|---|
| `not_found` | No candidate path existed; `searched` lists every path consulted |
| `parse_error` | TOML syntax error; `cause` carries the underlying error |
| `missing_env` | One or more `${VAR}` references unresolved; `missing` lists them |
| `validation_error` | Schema problem(s); `issues` lists every one with a dotted path + message |

```ts
try {
  await loadConfig()
} catch (err) {
  if (err instanceof ConfigError && err.code === 'validation_error') {
    for (const { path, message } of err.issues) console.error(`${path}: ${message}`)
  }
}
```

## Persistent state (`[runner.state]`)

The runner picks a cursor-store adapter from this discriminated union:

```toml
# Default when omitted: memory (lost on restart). Right for dev / tests.
[runner.state]
kind = "memory"

# Single-process daemons. Atomic JSON-file write; versioned on-disk format.
[runner.state]
kind = "file"
path = "./var/connectors-state/cursors.json"   # default: <runner.state_dir>/cursors.json

# Multi-process daemons sharing one Postgres. Single table, INSERT...ON CONFLICT.
[runner.state]
kind  = "postgres"
url   = "${STATEWAVE_DB_URL}"
table = "statewave_runner_cursors"             # default

# Multi-process daemons sharing one Redis. Single hash, HGET/HSET.
[runner.state]
kind       = "redis"
url        = "${REDIS_URL}"
key_prefix = "statewave_runner:"               # default; hash key is <prefix>cursors
```

`postgres` and `redis` require optional peer dependencies (`pg` / `ioredis`) — install them only if you select that kind.

Validation enforces:
- `kind` is one of `memory` / `file` / `postgres` / `redis`
- `postgres.url` and `redis.url` are required strings
- `postgres.table` matches `[a-zA-Z_][a-zA-Z0-9_]*` (the only identifier the adapter pastes into SQL — bound parameters are used everywhere else)

## Schedule strings

Pull-mode sources require a `schedule`:

- `every <N><unit>` where unit is `s` / `m` / `h` / `d` (e.g. `every 15m`, `every 1h`, `every 30s`)
- 5-field POSIX cron (e.g. `0 */1 * * *`)

This release validates the string shape; the runner (next wave) wires up the actual scheduler.

## Status

`v0.1.0` — the loader, validator, and `validate-config` CLI subcommand. The `run` daemon that consumes this config arrives in a follow-up release.
