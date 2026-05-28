import { ConnectorError } from "@statewavedev/connectors-core";
import type { RunOptions, SourceRow } from "../types.js";
import { importDriver } from "./load.js";

interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest;
  query(sql: string): Promise<{ recordset?: SourceRow[] }>;
}
interface MssqlPool {
  request(): MssqlRequest;
}
interface MssqlApi {
  connect(config: string): Promise<MssqlPool>;
  close(): Promise<void>;
}

/**
 * MSSQL has no per-session read-only flag like Postgres/MySQL. Read-only here
 * is enforced by the SELECT-only guard plus the strong recommendation to point
 * `connectionUrl` at a read-only login. Documented in the README.
 */
export async function runMssql(opts: RunOptions): Promise<ReadonlyArray<SourceRow>> {
  const mssql = await importDriver("mssql") as unknown as MssqlApi;
  if (typeof mssql.connect !== "function") {
    throw new ConnectorError("connect() not found in the installed 'mssql' module", {
      code: "config_invalid",
      connector: "database",
    });
  }
  const pool = await mssql.connect(opts.connectionUrl);
  try {
    const request = pool.request();
    opts.params.forEach((value, i) => {
      request.input(`p${i + 1}`, value);
    });
    const result = await request.query(opts.sql);
    return (result.recordset ?? []).slice(0, opts.maxRows);
  } finally {
    await mssql.close();
  }
}
