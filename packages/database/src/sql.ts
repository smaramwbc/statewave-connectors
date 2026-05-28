import { ConnectorError } from "@statewavedev/connectors-core";
import type { DatabaseDialectName, PreparedQuery } from "./types.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Statement keywords that must never appear in an operator-supplied query. */
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|exec|execute|into|copy)\b/i;

export interface SqlDialect {
  name: DatabaseDialectName;
  quoteIdent(ident: string): string;
  /** 1-based positional placeholder. */
  placeholder(index: number): string;
}

const BACKTICK: SqlDialect["quoteIdent"] = (id) => `\`${id}\``;

export const SQL_DIALECTS: Record<DatabaseDialectName, SqlDialect> = {
  postgres: {
    name: "postgres",
    quoteIdent: (id) => `"${id}"`,
    placeholder: (i) => `$${i}`,
  },
  mysql: {
    name: "mysql",
    quoteIdent: BACKTICK,
    placeholder: () => "?",
  },
  mariadb: {
    name: "mariadb",
    quoteIdent: BACKTICK,
    placeholder: () => "?",
  },
  mssql: {
    name: "mssql",
    quoteIdent: (id) => `[${id}]`,
    placeholder: (i) => `@p${i}`,
  },
};

/** Validate a bare identifier (column, or one segment of a table name). */
export function assertIdentifier(value: string, what: string): string {
  if (!IDENT.test(value)) {
    throw new ConnectorError(`invalid ${what} "${value}"`, {
      code: "config_invalid",
      connector: "database",
      hint: "identifiers must match [A-Za-z_][A-Za-z0-9_]* — no quotes, spaces, or punctuation",
    });
  }
  return value;
}

/** Quote a possibly schema-qualified table name (`schema.table`) safely. */
export function quoteTable(dialect: SqlDialect, table: string): string {
  const parts = table.split(".");
  if (parts.length > 2) {
    throw new ConnectorError(`invalid table "${table}"`, {
      code: "config_invalid",
      connector: "database",
      hint: "use 'table' or 'schema.table'",
    });
  }
  return parts.map((p) => dialect.quoteIdent(assertIdentifier(p, "table segment"))).join(".");
}

/**
 * Reject anything that isn't a single read-only SELECT/CTE. Best-effort
 * defense-in-depth that pairs with a read-only connection at the driver layer.
 */
export function assertReadOnlySelect(query: string): string {
  const q = query.trim().replace(/;\s*$/, "");
  if (/;/.test(q)) {
    throw new ConnectorError("query must be a single statement (no ';')", {
      code: "config_invalid",
      connector: "database",
    });
  }
  if (!/^(select|with)\b/i.test(q)) {
    throw new ConnectorError("query must be a read-only SELECT (or WITH … SELECT)", {
      code: "config_invalid",
      connector: "database",
    });
  }
  if (FORBIDDEN.test(q)) {
    throw new ConnectorError("query contains a forbidden (non-read-only) keyword", {
      code: "config_invalid",
      connector: "database",
      hint: "only read-only SELECT queries are allowed — no INSERT/UPDATE/DELETE/DDL/INTO",
    });
  }
  return q;
}

export interface TableSelectSpec {
  table: string;
  columns: ReadonlyArray<string>;
  idColumn: string;
  updatedAtColumn?: string;
  subjectColumn?: string;
  since?: string;
  maxRows: number;
}

/**
 * Build a parameterized, row-capped, deterministic SELECT for table mode.
 * All identifiers are validated + quoted; the only user *values* are bound
 * parameters (`since`), never string-interpolated.
 */
export function buildTableSelect(dialect: SqlDialect, spec: TableSelectSpec): PreparedQuery {
  if (!Number.isInteger(spec.maxRows) || spec.maxRows <= 0) {
    throw new ConnectorError(`maxRows must be a positive integer (got ${spec.maxRows})`, {
      code: "config_invalid",
      connector: "database",
    });
  }
  if (spec.columns.length === 0) {
    throw new ConnectorError("at least one column is required in table mode", {
      code: "config_invalid",
      connector: "database",
      hint: "set columns: ['id', 'updated_at', …] — a schema-wide dump is not allowed",
    });
  }
  // Union of ingested columns + id + updated_at + subject column, de-duplicated.
  const wanted = new Set<string>(spec.columns);
  wanted.add(spec.idColumn);
  if (spec.updatedAtColumn) wanted.add(spec.updatedAtColumn);
  if (spec.subjectColumn) wanted.add(spec.subjectColumn);

  const cols = [...wanted]
    .map((c) => dialect.quoteIdent(assertIdentifier(c, "column")))
    .join(", ");
  const table = quoteTable(dialect, spec.table);
  const orderCol = dialect.quoteIdent(
    assertIdentifier(spec.updatedAtColumn ?? spec.idColumn, "order column"),
  );

  const params: unknown[] = [];
  let where = "";
  if (spec.since && spec.updatedAtColumn) {
    const upd = dialect.quoteIdent(assertIdentifier(spec.updatedAtColumn, "column"));
    where = ` WHERE ${upd} > ${dialect.placeholder(1)}`;
    params.push(spec.since);
  }

  let sql: string;
  if (dialect.name === "mssql") {
    sql = `SELECT TOP (${spec.maxRows}) ${cols} FROM ${table}${where} ORDER BY ${orderCol} ASC`;
  } else {
    sql = `SELECT ${cols} FROM ${table}${where} ORDER BY ${orderCol} ASC LIMIT ${spec.maxRows}`;
  }
  return { sql, params, maxRows: spec.maxRows };
}
