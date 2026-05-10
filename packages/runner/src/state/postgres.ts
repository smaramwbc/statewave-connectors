// Postgres-backed pull cursor store.
//
// Single table, two columns + a composite primary key:
//
//   CREATE TABLE statewave_runner_cursors (
//     kind   text NOT NULL,
//     name   text NOT NULL,
//     cursor text NOT NULL,
//     updated_at timestamptz NOT NULL DEFAULT now(),
//     PRIMARY KEY (kind, name)
//   );
//
// `set()` is `INSERT ... ON CONFLICT (kind, name) DO UPDATE` — single
// round-trip, atomic. `get()` is a parameterized point query. Both
// use `pg`'s parameterized queries; `kind` and `name` are bound, never
// interpolated. The configurable `table` name is the only identifier
// pasted into SQL, so the config validator restricts it to
// `[a-zA-Z_][a-zA-Z0-9_]*` (already enforced in connectors-config).
//
// `pg` is an OPTIONAL peer dependency — operators using `kind="memory"`
// or `kind="file"` don't pay the install cost. The adapter dynamically
// imports `pg` so the absence is detected at adapter construction
// rather than at module load.

import type { ClosablePullCursorStore } from "./types.js";

export interface PostgresPullCursorStoreOptions {
  /** Postgres connection URL, e.g. `postgres://user:pass@host:5432/db`.
   * Required unless `pool` is injected. */
  url?: string;
  /** Table name. Must match `[a-zA-Z_][a-zA-Z0-9_]*` (validator-enforced).
   * Default `statewave_runner_cursors`. */
  table?: string;
  /**
   * Inject a pre-built `pg`-compatible pool. When provided, the adapter
   * skips the dynamic `pg` import — useful for tests and for embedders
   * who already maintain their own connection pool. The pool's
   * `query(text, values?)` and `end()` methods are the only surface
   * the adapter calls.
   */
  pool?: PgPoolLike;
}

/**
 * Minimal interface the adapter calls — narrower than the real `pg.Pool`
 * type so the adapter doesn't need `@types/pg` at build time.
 */
export interface PgPoolLike {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

const DEFAULT_TABLE = "statewave_runner_cursors";

/**
 * Construct, connect, and create-if-missing the cursors table. Returns
 * a ready-to-use store; throws if `pg` isn't installed, the URL is
 * unreachable, or the table can't be created.
 */
export async function openPostgresPullCursorStore(
  options: PostgresPullCursorStoreOptions,
): Promise<ClosablePullCursorStore> {
  const table = options.table ?? DEFAULT_TABLE;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(
      `postgres state adapter: table "${table}" must be a SQL-safe identifier`,
    );
  }

  let pool: PgPoolLike;
  if (options.pool) {
    pool = options.pool;
  } else {
    if (!options.url) {
      throw new Error("postgres state adapter: url is required when pool is not injected");
    }
    type PgModule = { Pool: new (opts: { connectionString: string }) => PgPoolLike };
    let pgModule: PgModule;
    try {
      // Indirect via a string to keep tsc from following the import for
      // type resolution — `pg` is an optional peer dep, so the types
      // package shouldn't be a hard build requirement.
      const moduleName = "pg";
      pgModule = (await import(moduleName)) as unknown as PgModule;
    } catch {
      throw new Error(
        `postgres state adapter requires the optional peer dependency \`pg\`. ` +
          `Install it: \`npm install pg\` (or pnpm/yarn). ` +
          `The runner only loads pg when [runner.state] kind = "postgres".`,
      );
    }
    pool = new pgModule.Pool({ connectionString: options.url });
  }

  // Idempotent — safe to run on every startup, costs ~one round-trip.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${table} (
       kind        text NOT NULL,
       name        text NOT NULL,
       cursor      text NOT NULL,
       updated_at  timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (kind, name)
     )`,
  );

  return {
    async get(kind: string, name: string): Promise<string | undefined> {
      const r = await pool.query<{ cursor: string }>(
        `SELECT cursor FROM ${table} WHERE kind = $1 AND name = $2`,
        [kind, name],
      );
      return r.rows[0]?.cursor;
    },
    async set(kind: string, name: string, cursor: string): Promise<void> {
      await pool.query(
        `INSERT INTO ${table} (kind, name, cursor)
         VALUES ($1, $2, $3)
         ON CONFLICT (kind, name) DO UPDATE
         SET cursor = EXCLUDED.cursor,
             updated_at = now()`,
        [kind, name, cursor],
      );
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
