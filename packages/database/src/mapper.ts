import { ConnectorError, EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type { DatabaseDialectName, SourceRow, TableSchema } from "./types.js";

export interface MapperOptions {
  dialect: DatabaseDialectName;
  /** Logical source name — the table name, or "query". Used in subject + provenance. */
  sourceName: string;
  idColumn: string;
  updatedAtColumn?: string;
  /** Columns to ingest. When empty, all row keys are used (query mode). */
  columns?: ReadonlyArray<string>;
  subject?: string;
  subjectColumn?: string;
  subjectPrefix?: string;
}

export function defaultSubject(sourceName: string): string {
  return `database:${sourceName}`;
}

export function mapRow(row: SourceRow, options: MapperOptions): StatewaveEpisode {
  const idValue = row[options.idColumn];
  if (idValue === undefined || idValue === null) {
    throw new ConnectorError(`row is missing id column "${options.idColumn}"`, {
      code: "mapping_failed",
      connector: "database",
    });
  }
  const id = String(idValue);
  const subject = resolveSubject(row, options);
  const occurred = options.updatedAtColumn ? toIso(row[options.updatedAtColumn]) : undefined;

  const ingestCols =
    options.columns && options.columns.length > 0 ? options.columns : Object.keys(row);
  const fields: Record<string, unknown> = {};
  for (const col of ingestCols) {
    const scalar = scalarize(row[col]);
    if (scalar !== undefined) fields[col] = scalar;
  }

  const builder = new EpisodeBuilder({ subject });
  return builder.build({
    kind: "database.row",
    text: composeText(options.sourceName, id, fields),
    occurred_at: occurred,
    source: {
      type: `database.${options.dialect}`,
      id: `${options.sourceName}#${id}`,
    },
    metadata: {
      dialect: options.dialect,
      source: options.sourceName,
      row_id: id,
      updated_at: occurred,
      fields,
      related_subjects: [`row:${id}`],
    },
    idempotency_parts: ["database", options.sourceName, id],
  });
}

export interface SchemaMapperOptions {
  dialect: DatabaseDialectName;
  /** Fixed subject for schema episodes (default `database:schema`). */
  subject?: string;
}

/** Default subject for schema-metadata episodes. */
export function defaultSchemaSubject(): string {
  return "database:schema";
}

/** Map one introspected {@link TableSchema} to a `database.schema` episode. */
export function mapTableSchema(
  schema: TableSchema,
  options: SchemaMapperOptions,
): StatewaveEpisode {
  const qualified = schema.schema ? `${schema.schema}.${schema.table}` : schema.table;
  const subject = options.subject ?? defaultSchemaSubject();

  const lines: string[] = [`${qualified} schema (${options.dialect})`, "columns:"];
  for (const c of schema.columns) {
    const nn = c.nullable ? "" : " not null";
    lines.push(`- ${c.name} ${c.dataType}${nn}`);
  }
  if (schema.primaryKey.length > 0) {
    lines.push(`primary key: ${schema.primaryKey.join(", ")}`);
  }
  if (schema.indexes.length > 0) {
    lines.push("indexes:");
    for (const ix of schema.indexes) {
      const uq = ix.unique ? " unique" : "";
      lines.push(`- ${ix.name} (${ix.columns.join(", ")})${uq}`);
    }
  }

  const builder = new EpisodeBuilder({ subject });
  return builder.build({
    kind: "database.schema",
    text: lines.join("\n"),
    source: {
      type: `database.${options.dialect}`,
      id: `schema:${qualified}`,
    },
    metadata: {
      dialect: options.dialect,
      schema: schema.schema,
      table: schema.table,
      column_count: schema.columns.length,
      columns: schema.columns.map((c) => ({
        name: c.name,
        data_type: c.dataType,
        nullable: c.nullable,
        default: c.default,
      })),
      primary_key: schema.primaryKey,
      indexes: schema.indexes.map((ix) => ({
        name: ix.name,
        columns: ix.columns,
        unique: ix.unique,
      })),
      related_subjects: [`table:${qualified}`],
    },
    idempotency_parts: ["database", "schema", options.dialect, qualified],
  });
}

function resolveSubject(row: SourceRow, options: MapperOptions): string {
  if (options.subjectColumn) {
    const raw = row[options.subjectColumn];
    if (raw !== undefined && raw !== null) {
      const prefix = options.subjectPrefix ?? options.sourceName;
      return `${prefix}:${String(raw)}`;
    }
  }
  return options.subject ?? defaultSubject(options.sourceName);
}

function composeText(sourceName: string, id: string, fields: Record<string, unknown>): string {
  const header = `${sourceName} row ${id}`;
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${stringifyValue(v)}`);
  return lines.length > 0 ? `${header}\n${lines.join("\n")}` : header;
}

/**
 * Reduce a raw column value to something safe + JSON-friendly. Drops binary
 * (Buffer / typed-array) values entirely — this connector does not ingest
 * blobs. Dates become ISO strings; plain objects (JSON columns) pass through.
 */
function scalarize(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (isBinary(value)) return undefined;
  if (value instanceof Date) return value.toISOString();
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") return (value as bigint).toString();
  if (t === "object") return value; // JSON column, etc.
  return undefined;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function isBinary(value: unknown): boolean {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return true;
  return ArrayBuffer.isView(value as ArrayBufferView) || value instanceof ArrayBuffer;
}

function toIso(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
