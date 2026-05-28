export type DatabaseDialectName = "postgres" | "mysql" | "mariadb" | "mssql";

export type DatabaseEventKind = "database.row" | "database.schema";

/** Ingestion mode. `rows` (default) ingests selected data rows; `schema` ingests
 * read-only catalog metadata (columns / primary key / indexes) for an explicit
 * table allowlist and **never reads data rows**. */
export type DatabaseMode = "rows" | "schema";

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

  /**
   * Ingestion mode. Defaults to `rows`. `schema` is an **opt-in** metadata-only
   * mode: it reads catalog views (columns / primary key / indexes) for the
   * `tables` allowlist and **never reads data rows**, never crawls the whole
   * instance, and never introspects un-listed tables.
   */
  mode?: DatabaseMode;

  /** Allowlisted table (optionally schema-qualified) to read from (rows mode). */
  table?: string;
  /** Columns to ingest (required with `table` in rows mode). Identifiers are validated. */
  columns?: ReadonlyArray<string>;

  /** A single read-only SELECT (alternative to `table`, rows mode). Validated; rows capped client-side. */
  query?: string;

  /**
   * Explicit table allowlist for **schema mode** — each entry is `table` or
   * `schema.table`. Required (and non-empty) in schema mode; there is no
   * whole-instance / un-listed-table introspection.
   */
  tables?: ReadonlyArray<string>;

  /** Column whose value is the row id — required in rows mode for stable provenance + idempotency. */
  idColumn?: string;
  /** Column used for `occurred_at` and incremental `since` filtering — recommended (rows mode). */
  updatedAtColumn?: string;

  /** Hard cap on rows ingested per run — required in rows mode. */
  maxRows?: number;

  /** Fixed subject for every row (e.g. "database:support_tickets"). */
  subject?: string;
  /** Per-row subject from a column value (overrides `subject` when set). */
  subjectColumn?: string;
  /** Prefix for `subjectColumn` values (default derived from table/"row"). */
  subjectPrefix?: string;

  /** Test seam: inject a driver to run rows without a live database. */
  driver?: DatabaseDriver;
}

/** A parsed, validated table reference for schema mode. */
export interface TableRef {
  /** Schema/owner, when the allowlist entry was `schema.table`; else undefined. */
  schema?: string;
  /** Bare table name. */
  table: string;
}

/** One column's catalog metadata. */
export interface ColumnSchema {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
}

/** One index's catalog metadata. */
export interface IndexSchema {
  name: string;
  columns: ReadonlyArray<string>;
  unique: boolean;
}

/** The introspected schema for a single allowlisted table. */
export interface TableSchema {
  schema?: string;
  table: string;
  columns: ReadonlyArray<ColumnSchema>;
  primaryKey: ReadonlyArray<string>;
  indexes: ReadonlyArray<IndexSchema>;
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
