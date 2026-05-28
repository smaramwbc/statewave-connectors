import { describe, it, expect } from "vitest";
import {
  assertReadOnlySelect,
  buildTableSelect,
  createDatabaseConnector,
  defaultSubject,
  mapRow,
  SQL_DIALECTS,
} from "../src/index.js";
import type { DatabaseConnectorConfig, MapperOptions, SourceRow } from "../src/index.js";

const baseSpec = {
  table: "support_tickets",
  columns: ["subject", "status"],
  idColumn: "id",
  updatedAtColumn: "updated_at",
  since: "2026-01-01T00:00:00.000Z",
  maxRows: 100,
};

describe("buildTableSelect", () => {
  it("postgres: double-quoted idents, $n placeholder, LIMIT", () => {
    const q = buildTableSelect(SQL_DIALECTS.postgres, baseSpec);
    expect(q.sql).toContain('FROM "support_tickets"');
    expect(q.sql).toContain('"subject"');
    expect(q.sql).toContain('WHERE "updated_at" > $1');
    expect(q.sql).toContain('ORDER BY "updated_at" ASC');
    expect(q.sql).toContain("LIMIT 100");
    expect(q.params).toEqual(["2026-01-01T00:00:00.000Z"]);
  });

  it("mysql: backtick idents, ? placeholder, LIMIT", () => {
    const q = buildTableSelect(SQL_DIALECTS.mysql, baseSpec);
    expect(q.sql).toContain("FROM `support_tickets`");
    expect(q.sql).toContain("WHERE `updated_at` > ?");
    expect(q.sql).toContain("LIMIT 100");
  });

  it("mssql: bracket idents, TOP (n), @pN placeholder, no LIMIT", () => {
    const q = buildTableSelect(SQL_DIALECTS.mssql, baseSpec);
    expect(q.sql).toContain("SELECT TOP (100)");
    expect(q.sql).toContain("FROM [support_tickets]");
    expect(q.sql).toContain("WHERE [updated_at] > @p1");
    expect(q.sql).not.toContain("LIMIT");
  });

  it("quotes a schema-qualified table per segment", () => {
    const q = buildTableSelect(SQL_DIALECTS.postgres, { ...baseSpec, table: "app.support_tickets" });
    expect(q.sql).toContain('FROM "app"."support_tickets"');
  });

  it("rejects an injection attempt in a column name", () => {
    expect(() =>
      buildTableSelect(SQL_DIALECTS.postgres, { ...baseSpec, columns: ["subject; DROP TABLE x"] }),
    ).toThrow();
  });

  it("rejects a non-positive maxRows", () => {
    expect(() => buildTableSelect(SQL_DIALECTS.postgres, { ...baseSpec, maxRows: 0 })).toThrow();
  });
});

describe("assertReadOnlySelect", () => {
  it("accepts a plain SELECT and a CTE", () => {
    expect(assertReadOnlySelect("SELECT id FROM t")).toBe("SELECT id FROM t");
    expect(assertReadOnlySelect("WITH x AS (SELECT 1) SELECT * FROM x")).toContain("SELECT");
  });

  it("rejects multiple statements, writes, and SELECT INTO", () => {
    expect(() => assertReadOnlySelect("SELECT 1; DROP TABLE t")).toThrow();
    expect(() => assertReadOnlySelect("DELETE FROM t")).toThrow();
    expect(() => assertReadOnlySelect("UPDATE t SET x=1")).toThrow();
    expect(() => assertReadOnlySelect("SELECT * INTO new_t FROM t")).toThrow();
  });
});

describe("mapRow", () => {
  const opts: MapperOptions = {
    dialect: "postgres",
    sourceName: "support_tickets",
    idColumn: "id",
    updatedAtColumn: "updated_at",
    columns: ["subject", "status", "secret_blob"],
  };

  it("maps a row to a database.row episode, skipping binary columns", () => {
    const row: SourceRow = {
      id: 7,
      subject: "Login broken",
      status: "open",
      updated_at: "2026-05-01T00:00:00Z",
      secret_blob: Buffer.from([1, 2, 3]),
    };
    const ep = mapRow(row, opts);
    expect(ep.subject).toBe("database:support_tickets");
    expect(ep.kind).toBe("database.row");
    expect(ep.source.type).toBe("database.postgres");
    expect(ep.source.id).toBe("support_tickets#7");
    expect(ep.occurred_at).toBe("2026-05-01T00:00:00.000Z");
    expect(ep.metadata?.row_id).toBe("7");
    expect(ep.text).toContain("support_tickets row 7");
    expect(ep.text).toContain("subject: Login broken");
    expect(ep.text).not.toContain("secret_blob");
    const fields = ep.metadata?.fields as Record<string, unknown>;
    expect(fields.subject).toBe("Login broken");
    expect(fields.secret_blob).toBeUndefined();
  });

  it("derives a per-row subject from subjectColumn + prefix", () => {
    const ep = mapRow(
      { id: 1, customer_id: "acme", subject: "x" },
      { ...opts, subjectColumn: "customer_id", subjectPrefix: "customer", columns: ["subject"] },
    );
    expect(ep.subject).toBe("customer:acme");
  });

  it("idempotency key is stable across re-maps", () => {
    const row: SourceRow = { id: 7, subject: "x", status: "open", updated_at: "2026-05-01T00:00:00Z" };
    expect(mapRow(row, opts).idempotency_key).toBe(mapRow(row, opts).idempotency_key);
  });

  it("default subject helper", () => {
    expect(defaultSubject("tickets")).toBe("database:tickets");
  });
});

describe("createDatabaseConnector (with injected driver)", () => {
  const config: DatabaseConnectorConfig = {
    dialect: "postgres",
    connectionUrl: "postgres://user@localhost/db",
    table: "t",
    columns: ["a"],
    idColumn: "id",
    maxRows: 2,
    driver: {
      fetchRows: async () => [
        { id: 1, a: "x" },
        { id: 2, a: "y" },
        { id: 3, a: "z" },
      ],
    },
  };

  it("maps rows, caps at maxRows, and respects dry-run", async () => {
    const c = createDatabaseConnector(config);
    const res = await c.sync({ dryRun: true });
    expect(res.episodes.length).toBe(2);
    expect(res.ingested).toBe(0);
    expect(res.dryRun).toBe(true);
    expect(res.episodes[0]?.subject).toBe("database:t");
  });

  it("rejects setting both table and query", () => {
    expect(() => createDatabaseConnector({ ...config, query: "SELECT 1" })).toThrow();
  });

  it("rejects setting neither table nor query", () => {
    const { table, columns, ...rest } = config;
    void table;
    void columns;
    expect(() => createDatabaseConnector(rest as DatabaseConnectorConfig)).toThrow();
  });
});
