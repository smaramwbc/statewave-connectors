# Tester handoff — Jira + Database source connectors (preview)

Thanks for helping test the two newest **preview** source connectors:

- **`@statewavedev/connectors-jira`** — pulls Jira Cloud issues/comments into Statewave memory.
- **`@statewavedev/connectors-database`** — pulls selected rows from PostgreSQL / MySQL / MariaDB / MSSQL into Statewave memory.

> **Preview, not production.** These are early source connectors for evaluation. They ingest **external records into Statewave memory** — they do **not** change how Statewave stores its own data (Statewave's storage remains PostgreSQL + pgvector), and they **never write** to your source system.

## Prerequisites

- Node ≥ 20.
- (Optional) a running Statewave instance for real ingestion — `STATEWAVE_URL` (+ `STATEWAVE_API_KEY` if required). You can do everything below with **`--dry-run`** and no Statewave instance.
- For Jira: a Jira Cloud site + an **API token** (`https://id.atlassian.com/manage-profile/security/api-tokens`).
- For the database connector: a database you can reach with a **read-only** login, plus the driver for your dialect (`pg` / `mysql2` / `mssql`).

## Getting the connectors

**Once published (npm):**

```bash
npm install -g @statewavedev/connectors-cli
npm install @statewavedev/connectors-jira @statewavedev/connectors-database
npm install pg            # or mysql2 / mssql for your DB dialect
```

**Right now (pre-publish) — clone + build:**

```bash
git clone https://github.com/smaramwbc/statewave-connectors && cd statewave-connectors
corepack enable && pnpm install && pnpm build
# run the CLI from the repo:
node packages/cli/dist/index.js --help
```

> ⚠️ As of this handoff the npm packages may not be published yet. If `npm view @statewavedev/connectors-jira` 404s, use the clone+build path. The commands below show `statewave-connectors …`; substitute `node packages/cli/dist/index.js …` when running from a clone.

## What to test

### Jira test path

```bash
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="…"            # never paste this into a file or a PR

statewave-connectors sync jira \
  --host https://YOURORG.atlassian.net \
  --projects ENG \
  --include issues,comments \
  --redact-email --redact-phone \
  --dry-run --json | head -60
```

- **Expected:** a `synced jira` summary, `kinds: jira.issue.created / jira.issue.resolved / jira.comment.created`, sample episodes under `project:ENG`, `ingested=0` (dry-run).
- **Confirm:** no email addresses appear in any episode (users show as display name / accountId). Descriptions/comments are plain text (ADF flattened).
- **No real instance?** You can still confirm the CLI wiring and config validation (it will report missing `--host` / auth / `--projects` clearly).

### Database test path

```bash
export STATEWAVE_DATABASE_SOURCE_URL="postgres://readonly_user@localhost:5432/app"

statewave-connectors sync database \
  --dialect postgres \
  --table support_tickets \
  --columns id,subject,status,updated_at \
  --id-column id --updated-at-column updated_at \
  --max-rows 100 \
  --subject database:support_tickets \
  --dry-run --json | head -60
```

- For MySQL/MariaDB use `--dialect mysql|mariadb`; for SQL Server `--dialect mssql`.
- **Query mode** (your own read-only SELECT): replace `--table/--columns` with `--query "SELECT id, subject, updated_at FROM support_tickets"`.
- **Expected:** `kind: database.row` episodes, one per row, capped at `--max-rows`, `ingested=0` (dry-run).

### Safe sample data

Use a throwaway DB / test Jira project. For the database connector, a tiny table is enough:

```sql
CREATE TABLE support_tickets (id int primary key, subject text, status text, updated_at timestamptz);
INSERT INTO support_tickets VALUES
 (1,'Cannot reset password','open', now()),
 (2,'Billing question','resolved', now());
```

## Safety checks we want you to confirm

- **Read-only:** the connector only SELECTs. Try `--query "DELETE FROM support_tickets"` → it must be **rejected** (`config_invalid`, "read-only SELECT").
- **No schema-wide dump:** table mode without `--columns`, or a bare `--query` that isn't a SELECT, must be rejected.
- **No inline secrets:** connection URL comes from `STATEWAVE_DATABASE_SOURCE_URL` / Jira token from `JIRA_API_TOKEN` — never on the command line or in a committed file.
- **Use a least-privilege read-only DB login** (especially for MSSQL — see below).

## Expected output (shape)

```json
{
  "subject": "database:support_tickets",
  "kind": "database.row",
  "text": "support_tickets row 1\nsubject: Cannot reset password\nstatus: open",
  "source": { "type": "database.postgres", "id": "support_tickets#1" },
  "metadata": { "dialect": "postgres", "row_id": "1", "fields": { … } }
}
```

## Common errors

| Symptom | Cause / fix |
|---|---|
| `the 'pg' driver is not installed` | `npm install pg` (or `mysql2` / `mssql` for your dialect). |
| `jira auth is required` | export `JIRA_EMAIL` + `JIRA_API_TOKEN`. |
| `--projects is required` | Jira refuses a whole-site pull; pass `--projects ENG`. |
| `query must be a read-only SELECT` | mutation/DDL queries are rejected by design. |
| `connection URL is required` | set `STATEWAVE_DATABASE_SOURCE_URL`. |
| `npm install @statewavedev/connectors-jira` 404 | not published yet — use the clone+build path. |

## What NOT to test yet (out of preview scope)

- **Jira webhooks / real-time sync** — pull-mode only ([#192](https://github.com/smaramwbc/statewave/issues/192)).
- **Jira Data Center / Server** — Cloud only ([#193](https://github.com/smaramwbc/statewave/issues/193)).
- **Jira sprint/board/change-history** — preview mapping only ([#194](https://github.com/smaramwbc/statewave/issues/194)).
- **MSSQL against a live server** — SQL builder + mapping are unit-tested but the live path is unvalidated; if you do try it, **use a read-only login** and treat results as experimental ([#190](https://github.com/smaramwbc/statewave/issues/190)).
- **Database schema-metadata mode** (tables/columns/indexes) — not built; tracked exploratory ([#191](https://github.com/smaramwbc/statewave/issues/191)).

## How to report feedback

Open a GitHub Discussion or issue on the central tracker: <https://github.com/smaramwbc/statewave/issues>. Include the connector, the command (with secrets redacted), the dialect/Jira-site type, and what you expected vs. saw.
