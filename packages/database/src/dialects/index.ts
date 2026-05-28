import { ConnectorError } from "@statewavedev/connectors-core";
import type { DatabaseDialectName, RunOptions, SourceRow } from "../types.js";
import { runPostgres } from "./postgres.js";
import { runMysql } from "./mysql.js";
import { runMssql } from "./mssql.js";

export type Runner = (opts: RunOptions) => Promise<ReadonlyArray<SourceRow>>;

export function runnerFor(dialect: DatabaseDialectName): Runner {
  switch (dialect) {
    case "postgres":
      return runPostgres;
    case "mysql":
    case "mariadb":
      return runMysql;
    case "mssql":
      return runMssql;
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
