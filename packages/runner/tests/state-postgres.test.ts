import { describe, it, expect, vi } from "vitest";
import {
  openPostgresPullCursorStore,
  type PgPoolLike,
} from "../src/state/postgres.js";

/**
 * Tiny in-memory stub of the `pg.Pool` surface the adapter actually
 * uses. Stores rows in a Map; supports the three SQL shapes the
 * adapter emits (CREATE TABLE IF NOT EXISTS, SELECT, INSERT...ON
 * CONFLICT). We deliberately match by SQL substring rather than
 * parsing it — the goal is "this is what the adapter sends" not
 * "this is what postgres would do" (we trust postgres separately).
 */
function makeFakePool(): PgPoolLike & { rows: Map<string, string>; queries: string[]; ended: boolean } {
  const rows = new Map<string, string>();
  const queries: string[] = [];
  let ended = false;
  return {
    rows,
    queries,
    get ended() {
      return ended;
    },
    async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      queries.push(text);
      if (text.startsWith("CREATE TABLE")) return { rows: [] as T[] };
      if (text.startsWith("SELECT cursor")) {
        const [kind, name] = values as [string, string];
        const v = rows.get(`${kind}/${name}`);
        return v === undefined ? { rows: [] as T[] } : { rows: [{ cursor: v } as T] };
      }
      if (text.startsWith("INSERT")) {
        const [kind, name, cursor] = values as [string, string, string];
        rows.set(`${kind}/${name}`, cursor);
        return { rows: [] as T[] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    async end(): Promise<void> {
      ended = true;
    },
  };
}

describe("openPostgresPullCursorStore", () => {
  it("returns undefined for unknown keys (cold start)", async () => {
    const pool = makeFakePool();
    const store = await openPostgresPullCursorStore({ pool });
    expect(await store.get("github", "main")).toBeUndefined();
  });

  it("set + get round-trips through the SQL the adapter emits", async () => {
    const pool = makeFakePool();
    const store = await openPostgresPullCursorStore({ pool });
    await store.set("github", "main", "cursor-1");
    expect(await store.get("github", "main")).toBe("cursor-1");
    expect(pool.rows.get("github/main")).toBe("cursor-1");
  });

  it("creates the table on construction (idempotent)", async () => {
    const pool = makeFakePool();
    await openPostgresPullCursorStore({ pool });
    expect(pool.queries[0]).toMatch(/CREATE TABLE IF NOT EXISTS statewave_runner_cursors/);
  });

  it("uses the configured table name in every query", async () => {
    const pool = makeFakePool();
    const store = await openPostgresPullCursorStore({ pool, table: "custom_t" });
    await store.set("github", "main", "x");
    expect(pool.queries.every((q) => !q.includes("statewave_runner_cursors"))).toBe(true);
    expect(pool.queries.some((q) => q.includes("custom_t"))).toBe(true);
  });

  it("close() ends the pool", async () => {
    const pool = makeFakePool();
    const store = await openPostgresPullCursorStore({ pool });
    expect(pool.ended).toBe(false);
    await store.close();
    expect(pool.ended).toBe(true);
  });

  it("rejects a non-identifier table name BEFORE attempting to load pg", async () => {
    await expect(
      openPostgresPullCursorStore({
        url: "postgres://localhost/x",
        table: "foo; DROP TABLE x",
      }),
    ).rejects.toThrow(/SQL-safe identifier/);
  });

  it("rejects a table starting with a digit", async () => {
    await expect(
      openPostgresPullCursorStore({
        url: "postgres://localhost/x",
        table: "1cursors",
      }),
    ).rejects.toThrow(/SQL-safe identifier/);
  });

  it("rejects when neither url nor pool is supplied", async () => {
    await expect(openPostgresPullCursorStore({})).rejects.toThrow(/url is required/);
  });

  it("INSERT ... ON CONFLICT updates the cursor on second set()", async () => {
    const pool = makeFakePool();
    const store = await openPostgresPullCursorStore({ pool });
    await store.set("github", "main", "v1");
    await store.set("github", "main", "v2");
    expect(await store.get("github", "main")).toBe("v2");
    // Two INSERTs were emitted — the conflict resolution is in SQL,
    // not in the adapter.
    const inserts = pool.queries.filter((q) => q.startsWith("INSERT"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toMatch(/ON CONFLICT \(kind, name\) DO UPDATE/);
  });
});
