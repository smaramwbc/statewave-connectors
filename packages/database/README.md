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

## Install

```bash
# the connector + the unified CLI to run it
npm install -g @statewavedev/connectors-cli
npm install @statewavedev/connectors-database

# plus the driver for your dialect:
npm install pg          # postgres
npm install mysql2      # mysql / mariadb
npm install mssql       # mssql
```

The CLI (`statewave-connectors`) discovers the connector by name (`sync database`). You can also import `createDatabaseConnector` from `@statewavedev/connectors-database` directly.

## Safety model (preview)

- **Statewave's own storage is unchanged.** Statewave stores its memory in PostgreSQL + pgvector. This connector only *ingests selected external database rows into Statewave memory* — it is not an alternative Statewave storage backend, and Statewave does not "support MySQL/MSSQL" as its store.
- **Read-only credentials.** Use a **read-only database login**. Postgres/MySQL/MariaDB additionally set the session read-only; the query is SELECT-only-validated. **No mutation queries** (INSERT/UPDATE/DELETE/DDL/`SELECT … INTO` are rejected). **MSSQL** has no per-session read-only flag — you **must** point `connectionUrl` at a **least-privilege read-only login**.
- **Allowlisted source only.** Either a single `table` + explicit `columns`, or one operator-supplied read-only `SELECT`. **No schema-wide dump, no introspection, no blind table scan.**
- **Bounded.** `maxRows` is required and enforced both in SQL (`LIMIT` / `TOP`) and client-side.
- **Identifiers validated** (`[A-Za-z_][A-Za-z0-9_]*`) and quoted per dialect; values are always bound parameters, never interpolated.
- **No binary/blob ingestion** — binary column values are dropped.
- **No inline secrets.** Supply `connectionUrl` via `${ENV}` (e.g. `STATEWAVE_DATABASE_SOURCE_URL`) — never put a password in committed config.

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

For **MySQL** use `--dialect mysql`, **MariaDB** `--dialect mariadb`, **MSSQL** `--dialect mssql` — same flags, different `--dialect` and `connectionUrl`.

To **actually ingest**, drop `--dry-run` and point at Statewave:

```bash
export STATEWAVE_URL="http://localhost:8100"
statewave-connectors sync database --dialect postgres --table support_tickets \
  --columns id,subject,status,updated_at --id-column id --updated-at-column updated_at \
  --max-rows 500 --subject database:support_tickets
```

## Subject strategy

Use a **fixed subject** for the whole table (`--subject database:support_tickets`), or derive a **per-row subject** from a column with `--subject-column <col>` (+ optional `--subject-prefix`), e.g. one subject per customer id. Default if neither is set: `database:<table-or-query>`.

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

## MSSQL preview status

MSSQL is included in this preview, with two caveats worth calling out:

- Unlike Postgres/MySQL/MariaDB, MSSQL has **no per-session read-only flag**. Read-only is enforced by the SELECT-only guard **plus** the login you provide — so you **must** use a **least-privilege read-only login**.
- The MSSQL path was **not exercised against a live SQL Server** in our environment; its SQL builder and row→episode mapping are covered by unit tests (green), but the live connection path is unverified. **Validate against your own MSSQL instance before relying on it.**

## Status

`v0.1.0` **preview** source connector — not production-ready ETL. Pull-mode,
read-only. Schema-metadata harvesting, introspection, change-data-capture, and
write-back are explicitly out of scope.
