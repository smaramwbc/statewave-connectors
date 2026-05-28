import { ConnectorError } from "@statewavedev/connectors-core";
import type { RunOptions, SourceRow } from "../types.js";
import { importDriver } from "./load.js";

interface PgClient {
  connect(): Promise<void>;
  query(text: string, params?: ReadonlyArray<unknown>): Promise<{ rows: SourceRow[] }>;
  end(): Promise<void>;
}
type PgClientCtor = new (config: { connectionString: string }) => PgClient;

export async function runPostgres(opts: RunOptions): Promise<ReadonlyArray<SourceRow>> {
  const pg = await importDriver("pg");
  const Client = pg["Client"] as PgClientCtor | undefined;
  if (!Client) {
    throw new ConnectorError("pg.Client not found in the installed 'pg' module", {
      code: "config_invalid",
      connector: "database",
    });
  }
  const client = new Client({ connectionString: opts.connectionUrl });
  await client.connect();
  try {
    // Belt-and-suspenders with the SELECT-only guard: refuse writes at the session.
    await client.query("SET default_transaction_read_only = on");
    const res = await client.query(opts.sql, [...opts.params]);
    return res.rows.slice(0, opts.maxRows);
  } finally {
    await client.end();
  }
}
