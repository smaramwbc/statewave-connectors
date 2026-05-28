import { describe, it, expect } from "vitest";
import {
  buildColumnsQuery,
  buildIndexQuery,
  buildPrimaryKeyQuery,
  createDatabaseConnector,
  defaultSchemaSubject,
  mapTableSchema,
  parseTableRef,
  rowsToColumns,
  rowsToIndexes,
} from "../src/index.js";
import type {
  DatabaseConnectorConfig,
  SourceRow,
  TableSchema,
} from "../src/index.js";

describe("parseTableRef", () => {
  it("parses a bare table", () => {
    expect(parseTableRef("support_tickets")).toEqual({ table: "support_tickets" });
  });
  it("parses schema.table", () => {
    expect(parseTableRef("public.support_tickets")).toEqual({
      schema: "public",
      table: "support_tickets",
    });
  });
  it("rejects three-part names and bad identifiers", () => {
    expect(() => parseTableRef("a.b.c")).toThrow();
    expect(() => parseTableRef("bad-name")).toThrow();
    expect(() => parseTableRef("")).toThrow();
    expect(() => parseTableRef("a.")).toThrow();
  });
});

describe("catalog query builders", () => {
  it("columns: portable information_schema.columns, default schema per dialect", () => {
    const pg = buildColumnsQuery("postgres", { table: "t" });
    expect(pg.sql).toContain("FROM information_schema.columns");
    expect(pg.sql).toContain("table_name = $1");
    expect(pg.sql).toContain("table_schema = $2");
    expect(pg.params).toEqual(["t", "public"]);

    const my = buildColumnsQuery("mysql", { table: "t" });
    expect(my.sql).toContain("table_name = ?");
    expect(my.sql).toContain("table_schema = DATABASE()");
    expect(my.params).toEqual(["t"]);

    const ms = buildColumnsQuery("mssql", { table: "t" });
    expect(ms.sql).toContain("table_name = @p1");
    expect(ms.sql).toContain("table_schema = SCHEMA_NAME()");
    expect(ms.params).toEqual(["t"]);
  });

  it("columns: explicit schema binds a parameter on every dialect", () => {
    const my = buildColumnsQuery("mysql", { schema: "app", table: "t" });
    expect(my.sql).toContain("table_schema = ?");
    expect(my.params).toEqual(["t", "app"]);
  });

  it("primary key: filters TABLE_CONSTRAINTS on PRIMARY KEY", () => {
    const q = buildPrimaryKeyQuery("postgres", { table: "t" });
    expect(q.sql).toContain("information_schema.table_constraints");
    expect(q.sql).toContain("information_schema.key_column_usage");
    expect(q.sql).toContain("constraint_type = 'PRIMARY KEY'");
    expect(q.params).toEqual(["t", "public"]);
  });

  it("indexes: dialect-specific catalogs", () => {
    expect(buildIndexQuery("postgres", { table: "t" }).sql).toContain("pg_index");
    expect(buildIndexQuery("mysql", { table: "t" }).sql).toContain(
      "information_schema.statistics",
    );
    const ms = buildIndexQuery("mssql", { schema: "dbo", table: "t" });
    expect(ms.sql).toContain("sys.indexes");
    expect(ms.sql).toContain("OBJECT_ID(@p1)");
    expect(ms.params).toEqual(["dbo.t"]);
  });
});

describe("row normalizers", () => {
  it("rowsToColumns maps nullability + default", () => {
    const cols = rowsToColumns([
      { name: "id", data_type: "integer", is_nullable: "NO", column_default: "nextval(...)" },
      { name: "note", data_type: "text", is_nullable: "YES", column_default: null },
    ]);
    expect(cols).toEqual([
      { name: "id", dataType: "integer", nullable: false, default: "nextval(...)" },
      { name: "note", dataType: "text", nullable: true, default: null },
    ]);
  });

  it("rowsToIndexes groups columns and coerces unique across dialect shapes", () => {
    const idx = rowsToIndexes([
      { index_name: "pk", column_name: "id", is_unique: true, seq: 1 },
      { index_name: "by_status", column_name: "status", is_unique: 0, seq: 1 },
      { index_name: "by_status", column_name: "created_at", is_unique: 0, seq: 2 },
    ]);
    expect(idx).toEqual([
      { name: "pk", columns: ["id"], unique: true },
      { name: "by_status", columns: ["status", "created_at"], unique: false },
    ]);
  });
});

describe("mapTableSchema", () => {
  const schema: TableSchema = {
    schema: "public",
    table: "support_tickets",
    columns: [
      { name: "id", dataType: "integer", nullable: false, default: null },
      { name: "subject", dataType: "text", nullable: true, default: null },
    ],
    primaryKey: ["id"],
    indexes: [{ name: "support_tickets_pkey", columns: ["id"], unique: true }],
  };

  it("produces a database.schema episode with metadata and no data rows", () => {
    const ep = mapTableSchema(schema, { dialect: "postgres" });
    expect(ep.kind).toBe("database.schema");
    expect(ep.subject).toBe("database:schema");
    expect(ep.text).toContain("public.support_tickets schema (postgres)");
    expect(ep.text).toContain("id integer not null");
    expect(ep.text).toContain("primary key: id");
    expect(ep.metadata?.column_count).toBe(2);
    expect((ep.metadata?.primary_key as string[])).toEqual(["id"]);
    // No data values — only catalog metadata.
    expect(JSON.stringify(ep.metadata)).not.toContain("row_id");
  });

  it("idempotency keys on the qualified table (re-introspection updates one memory)", () => {
    const a = mapTableSchema(schema, { dialect: "postgres" });
    const changed: TableSchema = { ...schema, columns: [schema.columns[0]!] };
    const b = mapTableSchema(changed, { dialect: "postgres" });
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });

  it("default schema subject helper", () => {
    expect(defaultSchemaSubject()).toBe("database:schema");
  });
});

describe("createDatabaseConnector — schema mode (injected driver)", () => {
  // Route the three catalog queries by inspecting the generated SQL.
  const driver = {
    fetchRows: async (opts: { sql: string }): Promise<ReadonlyArray<SourceRow>> => {
      if (opts.sql.includes("information_schema.columns")) {
        return [
          { name: "id", data_type: "integer", is_nullable: "NO", column_default: null },
          { name: "status", data_type: "text", is_nullable: "YES", column_default: null },
        ];
      }
      if (opts.sql.includes("table_constraints")) {
        return [{ name: "id", ordinal_position: 1 }];
      }
      if (opts.sql.includes("pg_index")) {
        return [{ index_name: "tickets_pkey", column_name: "id", is_unique: true, seq: 1 }];
      }
      return [];
    },
  };

  const config: DatabaseConnectorConfig = {
    dialect: "postgres",
    connectionUrl: "postgres://reader@localhost/db",
    mode: "schema",
    tables: ["support_tickets", "public.users"],
    driver,
  };

  it("introspects each allowlisted table into a database.schema episode", async () => {
    const c = createDatabaseConnector(config);
    const res = await c.sync({ dryRun: true });
    expect(res.episodes.length).toBe(2);
    expect(res.episodes.every((e) => e.kind === "database.schema")).toBe(true);
    expect(res.ingested).toBe(0);
    expect(res.episodes[0]?.text).toContain("support_tickets schema (postgres)");
  });

  it("requires a non-empty tables allowlist", () => {
    const { tables, ...rest } = config;
    void tables;
    expect(() => createDatabaseConnector(rest as DatabaseConnectorConfig)).toThrow(
      /tables/,
    );
  });

  it("rejects row-mode data options in schema mode", () => {
    expect(() =>
      createDatabaseConnector({ ...config, table: "support_tickets", columns: ["id"] }),
    ).toThrow();
  });

  it("rejects an un-parseable table entry (no blind introspection)", () => {
    expect(() =>
      createDatabaseConnector({ ...config, tables: ["bad-name"] }),
    ).toThrow();
  });
});
