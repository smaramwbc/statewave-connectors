import { ConnectorError } from "@statewavedev/connectors-core";
import type { RunOptions, SourceRow } from "../types.js";
import { importDriver } from "./load.js";

interface MysqlConnection {
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}
type CreateConnection = (uri: string) => Promise<MysqlConnection>;

/** Serves both MySQL and MariaDB — same wire protocol, same mysql2 driver. */
export async function runMysql(opts: RunOptions): Promise<ReadonlyArray<SourceRow>> {
  const mysql = await importDriver("mysql2/promise");
  const createConnection = mysql["createConnection"] as CreateConnection | undefined;
  if (!createConnection) {
    throw new ConnectorError("createConnection not found in 'mysql2/promise'", {
      code: "config_invalid",
      connector: "database",
    });
  }
  const conn = await createConnection(opts.connectionUrl);
  try {
    // Make the implicit per-statement transaction read-only.
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    const [rows] = await conn.query(opts.sql, [...opts.params]);
    const list = Array.isArray(rows) ? (rows as SourceRow[]) : [];
    return list.slice(0, opts.maxRows);
  } finally {
    await conn.end();
  }
}
