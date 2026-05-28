# @statewavedev/connectors-database

**Preview** database **source** connector for Statewave — ingest *selected
rows* from an external relational database into Statewave memory.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

> **Boundary:** this reads external database rows **into** Statewave memory. It is **not** an alternative storage backend for Statewave — Statewave's own storage remains PostgreSQL + pgvector. It never writes to your database.

## Dialects

One package, four dialects via a `dialect` setting:

| `dialect` | Driver (install yourself — optional peer dep) |
|---|---|
| `postgres` | `pg` |
| `mysql` | `mysql2` |
| `mariadb` | `mysql2` |
| `mssql` | `mssql` |

Install only the driver for your dialect, e.g. `npm install pg`.

## Safety model (preview)

- **Read-only.** Postgres/MySQL/MariaDB run with the session set read-only; the query is SELECT-only-validated. **MSSQL** has no per-session read-only flag — point `connectionUrl` at a **read-only login**.
- **Allowlisted source.** Either a single `table` + explicit `columns`, or one operator-supplied read-only `SELECT`. **No schema-wide dump, no introspection, no blind table scan.**
- **Bounded.** `maxRows` is required and enforced both in SQL (`LIMIT` / `TOP`) and client-side.
- **Identifiers validated** (`[A-Za-z_][A-Za-z0-9_]*`) and quoted per dialect; values are always bound parameters, never interpolated.
- **No binary/blob ingestion** — binary column values are dropped.
- **Secrets via `${ENV}` only** — never put a password in committed config.

## Quickstart (dry-run)

```bash
export STATEWAVE_DATABASE_SOURCE_URL="postgres://reader@localhost:5432/app"

statewave-connectors sync database \
  --dialect postgres \
  --table support_tickets \
  --columns id,subject,status,updated_at \
  --id-column id \
  --updated-at-column updated_at \
  --max-rows 500 \
  --subject database:support_tickets \
  --dry-run
```

`connectionUrl` comes from `STATEWAVE_DATABASE_SOURCE_URL`. `--dry-run` connects
read-only, runs the SELECT, maps + prints episodes, and ingests nothing.

Query mode (operator-authored read-only SELECT):

```bash
statewave-connectors sync database \
  --dialect mysql \
  --query "SELECT id, subject, status, updated_at FROM support_tickets" \
  --id-column id --updated-at-column updated_at \
  --max-rows 500 --dry-run
```

## Example episode

```json
{
  "subject": "database:support_tickets",
  "kind": "database.row",
  "text": "support_tickets row 4821\nsubject: Cannot reset password\nstatus: open",
  "occurred_at": "2026-05-20T09:12:00.000Z",
  "source": { "type": "database.postgres", "id": "support_tickets#4821" },
  "metadata": {
    "dialect": "postgres",
    "source": "support_tickets",
    "row_id": "4821",
    "updated_at": "2026-05-20T09:12:00.000Z",
    "fields": { "subject": "Cannot reset password", "status": "open" },
    "related_subjects": ["row:4821"]
  },
  "idempotency_key": "…"
}
```

To get this exact shape, run the quickstart with `--dry-run --json`.

## Status

`v0.1.0` **preview** source connector. Pull-mode, read-only. Schema-metadata
harvesting, change-data-capture, and write-back are explicitly out of scope.
