export type DatabaseDialectName = "postgres" | "mysql" | "mariadb" | "mssql";

export type DatabaseEventKind = "database.row";

/** A row returned by a source query — column name → scalar value. */
export interface SourceRow {
  [column: string]: unknown;
}

/**
 * Source connector config. This connector ingests *selected rows* from an
 * external database into Statewave memory. It is read-only and never a
 * Statewave storage backend.
 *
 * Exactly one read source must be given: `table` (+ `columns`) OR `query`.
 */
export interface DatabaseConnectorConfig {
  dialect: DatabaseDialectName;
  /** Connection URL — supply via ${ENV}; never commit inline secrets. */
  connectionUrl: string;

  /** Allowlisted table (optionally schema-qualified) to read from. */
  table?: string;
  /** Columns to ingest (required with `table`). Identifiers are validated. */
  columns?: ReadonlyArray<string>;

  /** A single read-only SELECT (alternative to `table`). Validated; rows capped client-side. */
  query?: string;

  /** Column whose value is the row id — required for stable provenance + idempotency. */
  idColumn: string;
  /** Column used for `occurred_at` and incremental `since` filtering — recommended. */
  updatedAtColumn?: string;

  /** Hard cap on rows ingested per run — required. */
  maxRows: number;

  /** Fixed subject for every row (e.g. "database:support_tickets"). */
  subject?: string;
  /** Per-row subject from a column value (overrides `subject` when set). */
  subjectColumn?: string;
  /** Prefix for `subjectColumn` values (default derived from table/"row"). */
  subjectPrefix?: string;

  /** Test seam: inject a driver to run rows without a live database. */
  driver?: DatabaseDriver;
}

/** Resolved, validated SQL ready to execute against a dialect driver. */
export interface PreparedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
  /** Hard row cap the driver must not exceed (defense-in-depth alongside SQL LIMIT/TOP). */
  maxRows: number;
}

export interface RunOptions extends PreparedQuery {
  connectionUrl: string;
}

/** A driver connects (read-only), runs the prepared query, and disconnects. */
export interface DatabaseDriver {
  fetchRows(options: RunOptions): Promise<ReadonlyArray<SourceRow>>;
}
