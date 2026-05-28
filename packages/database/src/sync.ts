import {
  ConnectorError,
  redactEpisodeText,
  summarizeEpisodes,
  type ConnectorCheckResult,
  type StatewaveConnector,
  type StatewaveEpisode,
  type SyncOptions,
  type SyncResult,
} from "@statewavedev/connectors-core";
import { runnerFor, type Runner } from "./dialects/index.js";
import { mapRow, type MapperOptions } from "./mapper.js";
import {
  assertIdentifier,
  assertReadOnlySelect,
  buildTableSelect,
  SQL_DIALECTS,
} from "./sql.js";
import type {
  DatabaseConnectorConfig,
  DatabaseDialectName,
  PreparedQuery,
  RunOptions,
  SourceRow,
} from "./types.js";

const DIALECTS = new Set<DatabaseDialectName>(["postgres", "mysql", "mariadb", "mssql"]);

export function createDatabaseConnector(
  config: DatabaseConnectorConfig,
): StatewaveConnector<DatabaseConnectorConfig, SourceRow> {
  validateConfig(config);
  const sourceName = config.table ?? "query";
  const mapperOptions: MapperOptions = {
    dialect: config.dialect,
    sourceName,
    idColumn: config.idColumn,
    updatedAtColumn: config.updatedAtColumn,
    columns: config.table ? config.columns : undefined,
    subject: config.subject,
    subjectColumn: config.subjectColumn,
    subjectPrefix: config.subjectPrefix,
  };
  const runner: Runner = config.driver
    ? (opts: RunOptions) => config.driver!.fetchRows(opts)
    : runnerFor(config.dialect);

  return {
    id: `database:${config.dialect}:${sourceName}`,
    name: "Database",
    source: "database",

    async configure(_next: DatabaseConnectorConfig): Promise<void> {
      throw new ConnectorError("database connector is configured at construction time", {
        code: "unsupported",
        connector: "database",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      return {
        connector: "database",
        status: "ok",
        details: [
          { name: "dialect", status: "ok", message: config.dialect },
          { name: "source", status: "ok", message: config.table ? `table ${config.table}` : "query" },
          {
            name: "mode",
            status: "ok",
            message: "read-only; SELECT-only; allowlisted columns/query",
          },
          {
            name: "read_only_enforcement",
            status: config.dialect === "mssql" ? "warn" : "ok",
            message:
              config.dialect === "mssql"
                ? "mssql has no session read-only flag — use a read-only login"
                : "session set read-only",
          },
        ],
      };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const since = options.since ? new Date(options.since).toISOString() : undefined;
      const max = Math.min(config.maxRows, options.maxItems ?? config.maxRows);
      const prepared = prepareQuery(config, since, max);

      const rows = await runner({ connectionUrl: config.connectionUrl, ...prepared });
      const subject = options.subject
        ? { ...mapperOptions, subject: options.subject, subjectColumn: undefined }
        : mapperOptions;

      const episodes: StatewaveEpisode[] = rows.slice(0, max).map((row) => {
        const ep = mapRow(row, subject);
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const finishedAt = new Date().toISOString();
      return {
        connector: "database",
        source: "database",
        subject: options.subject ?? config.subject,
        episodes,
        ingested: dryRun ? 0 : episodes.length,
        skipped: rows.length - episodes.length,
        dryRun,
        startedAt,
        finishedAt,
        summary: summarizeEpisodes(episodes, {
          rows_fetched: rows.length,
          rows_mapped: episodes.length,
        }),
      };
    },

    async mapEvent(row: SourceRow): Promise<StatewaveEpisode> {
      return mapRow(row, mapperOptions);
    },
  };
}

function prepareQuery(
  config: DatabaseConnectorConfig,
  since: string | undefined,
  max: number,
): PreparedQuery {
  if (config.table) {
    return buildTableSelect(SQL_DIALECTS[config.dialect], {
      table: config.table,
      columns: config.columns ?? [],
      idColumn: config.idColumn,
      updatedAtColumn: config.updatedAtColumn,
      subjectColumn: config.subjectColumn,
      since,
      maxRows: max,
    });
  }
  // query mode — operator-supplied read-only SELECT; rows capped client-side.
  return { sql: assertReadOnlySelect(config.query as string), params: [], maxRows: max };
}

function validateConfig(config: DatabaseConnectorConfig): void {
  if (!DIALECTS.has(config.dialect)) {
    throw new ConnectorError(`unsupported dialect "${String(config.dialect)}"`, {
      code: "config_invalid",
      connector: "database",
      hint: "one of: postgres, mysql, mariadb, mssql",
    });
  }
  if (!config.connectionUrl) {
    throw new ConnectorError("connectionUrl is required (supply via ${ENV}, never inline)", {
      code: "config_invalid",
      connector: "database",
    });
  }
  const hasTable = !!config.table;
  const hasQuery = !!config.query;
  if (hasTable === hasQuery) {
    throw new ConnectorError("exactly one of `table` or `query` must be set", {
      code: "config_invalid",
      connector: "database",
      hint: "table mode (table + columns) or query mode (a single read-only SELECT)",
    });
  }
  if (hasTable && (!config.columns || config.columns.length === 0)) {
    throw new ConnectorError("`columns` is required in table mode (no schema-wide dump)", {
      code: "config_invalid",
      connector: "database",
    });
  }
  if (hasQuery) assertReadOnlySelect(config.query as string);
  assertIdentifier(config.idColumn, "idColumn");
  if (config.updatedAtColumn) assertIdentifier(config.updatedAtColumn, "updatedAtColumn");
  if (config.subjectColumn) assertIdentifier(config.subjectColumn, "subjectColumn");
  if (!Number.isInteger(config.maxRows) || config.maxRows <= 0) {
    throw new ConnectorError(`maxRows must be a positive integer (got ${config.maxRows})`, {
      code: "config_invalid",
      connector: "database",
    });
  }
}
