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
- **Allowlisted source only.** In the default **rows** mode: either a single `table` + explicit `columns`, or one operator-supplied read-only `SELECT`. **No schema-wide data dump, no blind table scan.** The opt-in **schema** mode reads catalog metadata only, and only for an explicit `--tables` allowlist — there is **no whole-instance crawl and no un-listed-table discovery** (see [Schema-metadata mode](#schema-metadata-mode-opt-in)).
- **Bounded.** In rows mode `maxRows` is required and enforced both in SQL (`LIMIT` / `TOP`) and client-side. Schema mode is bounded by the `--tables` allowlist.
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

## Schema-metadata mode (opt-in)

`--mode schema` ingests **catalog metadata** — column definitions, the primary
key, and indexes — for an explicit table allowlist, for agents that assist with
DB design / migration planning. It is **opt-in** and **never reads data rows**.

```bash
statewave-connectors sync database \
  --dialect postgres \
  --mode schema \
  --tables support_tickets,public.users \
  --dry-run
```

Per allowlisted table it emits one `database.schema` episode (default subject
`database:schema`, override with `--subject`). Boundaries specific to this mode:

- **Metadata only, never data.** It reads `information_schema` (columns + the
  primary key) and the read-only index catalog (`pg_index` /
  `information_schema.statistics` / `sys.indexes`). It never runs
  `SELECT … FROM <table>`.
- **Allowlist only — no crawl.** `--tables` is required and non-empty. Each
  entry is `table` or `schema.table`; un-qualified names resolve against the
  dialect's default schema (`public` / current DB / `dbo`). There is **no
  whole-instance crawl and no un-listed-table discovery**.
- **Same read-only enforcement** as rows mode (read-only login; session
  read-only where supported). `--table` / `--columns` / `--query` are rejected
  in schema mode.

Re-running re-introspects: the episode's idempotency key is the qualified table
name, so a schema change updates the same memory rather than creating a new one.

## Subject strategy

Use a **fixed subject** for the whole table (`--subject database:support_tickets`), or derive a **per-row subject** from a column with `--subject-column <col>` (+ optional `--subject-prefix`), e.g. one subject per customer id. Default if neither is set: `database:<table-or-query>`. In schema mode the default subject is `database:schema`.

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

Schema-mode episode (`--mode schema`):

```json
{
  "subject": "database:schema",
  "kind": "database.schema",
  "text": "support_tickets schema (postgres)\ncolumns:\n- id integer not null\n- subject text not null\n- status text\n- updated_at timestamp with time zone\nprimary key: id\nindexes:\n- idx_status (status)\n- support_tickets_pkey (id) unique\n- uq_subject (subject) unique",
  "source": { "type": "database.postgres", "id": "schema:support_tickets" },
  "metadata": {
    "dialect": "postgres",
    "table": "support_tickets",
    "column_count": 4,
    "columns": [
      { "name": "id", "data_type": "integer", "nullable": false, "default": null },
      { "name": "subject", "data_type": "text", "nullable": false, "default": null },
      { "name": "status", "data_type": "text", "nullable": true, "default": null },
      { "name": "updated_at", "data_type": "timestamp with time zone", "nullable": true, "default": null }
    ],
    "primary_key": ["id"],
    "indexes": [
      { "name": "idx_status", "columns": ["status"], "unique": false },
      { "name": "support_tickets_pkey", "columns": ["id"], "unique": true },
      { "name": "uq_subject", "columns": ["subject"], "unique": true }
    ],
    "related_subjects": ["table:support_tickets"]
  },
  "idempotency_key": "…"
}
```

## MSSQL notes

MSSQL is validated against a live SQL Server 2022 (dry-run: rows → episodes, mutation queries rejected). One caveat remains: unlike Postgres/MySQL/MariaDB, MSSQL has **no per-session read-only flag** — read-only is enforced by the SELECT-only guard **plus** the login you provide, so you **must** use a **least-privilege read-only login**.

## Status

**Preview** source connector. Pull-mode, read-only. Two modes: **rows** (selected
data rows) and the opt-in **schema** mode (catalog metadata for an explicit table
allowlist). Change-data-capture and any write-back remain explicitly out of scope.

All four dialects are live-verified in **rows** mode. Schema mode is live-verified
against PostgreSQL, MySQL, and SQL Server 2022; MariaDB uses the same
`information_schema.statistics` path as MySQL and is covered by unit tests.
