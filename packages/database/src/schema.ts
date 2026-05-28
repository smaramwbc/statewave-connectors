import { ConnectorError } from "@statewavedev/connectors-core";
import { assertIdentifier, SQL_DIALECTS } from "./sql.js";
import type {
  ColumnSchema,
  DatabaseDialectName,
  IndexSchema,
  PreparedQuery,
  RunOptions,
  SourceRow,
  TableRef,
  TableSchema,
} from "./types.js";

/**
 * Schema-metadata mode (opt-in). Reads **catalog views only** — column
 * definitions, primary key, and indexes — for an explicit table allowlist.
 *
 * Hard boundary, mirrored from the row-mode safety model:
 *   - **No data rows are read.** Only `information_schema` / system catalog
 *     metadata. Never `SELECT * FROM <table>`.
 *   - **Allowlist only.** Every table is introspected by exact name; there is
 *     no whole-instance crawl, no `LIKE`, no un-listed-table discovery.
 *   - **Identifiers validated + bound.** Table/schema names pass the same
 *     `[A-Za-z_][A-Za-z0-9_]*` guard and are always bound parameters.
 *   - **Read-only.** The same per-dialect read-only enforcement as row mode
 *     (session read-only where supported + a read-only login) applies, since
 *     these run through the identical driver runner.
 */

/** Client-side cap on catalog rows fetched per introspection query. */
const CATALOG_MAX_ROWS = 10_000;

export type SchemaRunner = (opts: RunOptions) => Promise<ReadonlyArray<SourceRow>>;

/** Parse + validate a `table` or `schema.table` allowlist entry. */
export function parseTableRef(entry: string): TableRef {
  const parts = entry.split(".");
  if (parts.length > 2 || parts.some((p) => p.length === 0)) {
    throw new ConnectorError(`invalid table reference "${entry}"`, {
      code: "config_invalid",
      connector: "database",
      hint: "use 'table' or 'schema.table'",
    });
  }
  if (parts.length === 2) {
    return {
      schema: assertIdentifier(parts[0]!, "schema"),
      table: assertIdentifier(parts[1]!, "table"),
    };
  }
  return { table: assertIdentifier(parts[0]!, "table") };
}

/**
 * Resolve the schema-filter clause for the portable INFORMATION_SCHEMA queries.
 * When the allowlist entry is unqualified we fall back to the dialect's default
 * schema function/literal rather than scanning every schema.
 */
function schemaFilter(
  dialect: DatabaseDialectName,
  ref: TableRef,
  column: string,
  nextParamIndex: number,
  params: unknown[],
): string {
  if (ref.schema) {
    params.push(ref.schema);
    return `${column} = ${SQL_DIALECTS[dialect].placeholder(nextParamIndex)}`;
  }
  switch (dialect) {
    case "mysql":
    case "mariadb":
      return `${column} = DATABASE()`;
    case "mssql":
      return `${column} = SCHEMA_NAME()`;
    case "postgres":
    default:
      params.push("public");
      return `${column} = ${SQL_DIALECTS[dialect].placeholder(nextParamIndex)}`;
  }
}

/** Columns for a table — portable INFORMATION_SCHEMA.COLUMNS. */
export function buildColumnsQuery(
  dialect: DatabaseDialectName,
  ref: TableRef,
): PreparedQuery {
  const params: unknown[] = [];
  params.push(ref.table);
  const tableClause = `table_name = ${SQL_DIALECTS[dialect].placeholder(1)}`;
  const schemaClause = schemaFilter(dialect, ref, "table_schema", 2, params);
  const sql =
    `SELECT column_name AS name, data_type AS data_type, ` +
    `is_nullable AS is_nullable, column_default AS column_default, ` +
    `ordinal_position AS ordinal_position ` +
    `FROM information_schema.columns ` +
    `WHERE ${tableClause} AND ${schemaClause} ` +
    `ORDER BY ordinal_position`;
  return { sql, params, maxRows: CATALOG_MAX_ROWS };
}

/** Primary-key columns — portable TABLE_CONSTRAINTS + KEY_COLUMN_USAGE. */
export function buildPrimaryKeyQuery(
  dialect: DatabaseDialectName,
  ref: TableRef,
): PreparedQuery {
  const params: unknown[] = [];
  params.push(ref.table);
  const tableClause = `tc.table_name = ${SQL_DIALECTS[dialect].placeholder(1)}`;
  const schemaClause = schemaFilter(dialect, ref, "tc.table_schema", 2, params);
  const sql =
    `SELECT kcu.column_name AS name, kcu.ordinal_position AS ordinal_position ` +
    `FROM information_schema.table_constraints tc ` +
    `JOIN information_schema.key_column_usage kcu ` +
    `ON tc.constraint_name = kcu.constraint_name ` +
    `AND tc.table_schema = kcu.table_schema ` +
    `AND tc.table_name = kcu.table_name ` +
    `WHERE tc.constraint_type = 'PRIMARY KEY' ` +
    `AND ${tableClause} AND ${schemaClause} ` +
    `ORDER BY kcu.ordinal_position`;
  return { sql, params, maxRows: CATALOG_MAX_ROWS };
}

/** Indexes for a table — dialect-specific catalog views (read-only). */
export function buildIndexQuery(
  dialect: DatabaseDialectName,
  ref: TableRef,
): PreparedQuery {
  switch (dialect) {
    case "postgres": {
      const params: unknown[] = [ref.table, ref.schema ?? "public"];
      const sql =
        `SELECT i.relname AS index_name, a.attname AS column_name, ` +
        `ix.indisunique AS is_unique, k.ord AS seq ` +
        `FROM pg_class t ` +
        `JOIN pg_namespace n ON n.oid = t.relnamespace ` +
        `JOIN pg_index ix ON ix.indrelid = t.oid ` +
        `JOIN pg_class i ON i.oid = ix.indexrelid ` +
        `JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true ` +
        `JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ` +
        `WHERE t.relname = $1 AND n.nspname = $2 ` +
        `ORDER BY index_name, seq`;
      return { sql, params, maxRows: CATALOG_MAX_ROWS };
    }
    case "mysql":
    case "mariadb": {
      const params: unknown[] = [ref.table];
      const schemaClause = ref.schema
        ? "table_schema = ?"
        : "table_schema = DATABASE()";
      if (ref.schema) params.push(ref.schema);
      const sql =
        `SELECT index_name AS index_name, column_name AS column_name, ` +
        `(non_unique = 0) AS is_unique, seq_in_index AS seq ` +
        `FROM information_schema.statistics ` +
        `WHERE table_name = ? AND ${schemaClause} ` +
        `ORDER BY index_name, seq_in_index`;
      return { sql, params, maxRows: CATALOG_MAX_ROWS };
    }
    case "mssql": {
      const qualified = ref.schema ? `${ref.schema}.${ref.table}` : ref.table;
      const params: unknown[] = [qualified];
      const sql =
        `SELECT idx.name AS index_name, col.name AS column_name, ` +
        `idx.is_unique AS is_unique, ic.key_ordinal AS seq ` +
        `FROM sys.indexes idx ` +
        `JOIN sys.index_columns ic ON ic.object_id = idx.object_id AND ic.index_id = idx.index_id ` +
        `JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id ` +
        `WHERE idx.object_id = OBJECT_ID(@p1) AND idx.name IS NOT NULL ` +
        `ORDER BY index_name, seq`;
      return { sql, params, maxRows: CATALOG_MAX_ROWS };
    }
    default: {
      const _exhaustive: never = dialect;
      void _exhaustive;
      throw new ConnectorError(`unsupported dialect: ${String(dialect)}`, {
        code: "config_invalid",
        connector: "database",
      });
    }
  }
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  const s = str(value).trim().toLowerCase();
  return s === "1" || s === "true" || s === "t" || s === "yes" || s === "y";
}

/** Assemble column rows into the normalized {@link ColumnSchema} list. */
export function rowsToColumns(rows: ReadonlyArray<SourceRow>): ColumnSchema[] {
  return rows.map((r) => ({
    name: str(r.name),
    dataType: str(r.data_type),
    nullable: str(r.is_nullable).trim().toUpperCase() === "YES",
    default: r.column_default === undefined || r.column_default === null
      ? null
      : str(r.column_default),
  }));
}

/** Group index rows (one per index column) into {@link IndexSchema}. */
export function rowsToIndexes(rows: ReadonlyArray<SourceRow>): IndexSchema[] {
  const byName = new Map<string, IndexSchema & { columns: string[] }>();
  const order: string[] = [];
  for (const r of rows) {
    const name = str(r.index_name);
    if (!name) continue;
    let idx = byName.get(name);
    if (!idx) {
      idx = { name, columns: [], unique: truthy(r.is_unique) };
      byName.set(name, idx);
      order.push(name);
    }
    const col = str(r.column_name);
    if (col) idx.columns.push(col);
  }
  return order.map((n) => byName.get(n)!);
}

/**
 * Introspect a single allowlisted table: columns + primary key + indexes.
 * Runs three read-only catalog queries through the same driver runner row mode
 * uses (so read-only enforcement is identical). No data rows are read.
 */
export async function introspectTable(
  runner: SchemaRunner,
  connectionUrl: string,
  dialect: DatabaseDialectName,
  ref: TableRef,
): Promise<TableSchema> {
  const columnRows = await runner({
    connectionUrl,
    ...buildColumnsQuery(dialect, ref),
  });
  if (columnRows.length === 0) {
    throw new ConnectorError(
      `table "${ref.schema ? `${ref.schema}.` : ""}${ref.table}" was not found (no columns in the catalog)`,
      {
        code: "mapping_failed",
        connector: "database",
        hint: "check the table name/schema and that the read-only login can see the catalog",
      },
    );
  }
  const pkRows = await runner({
    connectionUrl,
    ...buildPrimaryKeyQuery(dialect, ref),
  });
  const indexRows = await runner({
    connectionUrl,
    ...buildIndexQuery(dialect, ref),
  });
  return {
    schema: ref.schema,
    table: ref.table,
    columns: rowsToColumns(columnRows),
    primaryKey: pkRows.map((r) => str(r.name)).filter((n) => n.length > 0),
    indexes: rowsToIndexes(indexRows),
  };
}
