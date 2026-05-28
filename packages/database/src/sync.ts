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
import { mapRow, mapTableSchema, type MapperOptions } from "./mapper.js";
import {
  assertIdentifier,
  assertReadOnlySelect,
  buildTableSelect,
  SQL_DIALECTS,
} from "./sql.js";
import { introspectTable, parseTableRef } from "./schema.js";
import type {
  DatabaseConnectorConfig,
  DatabaseDialectName,
  PreparedQuery,
  RunOptions,
  SourceRow,
  TableRef,
} from "./types.js";

const DIALECTS = new Set<DatabaseDialectName>(["postgres", "mysql", "mariadb", "mssql"]);

export function createDatabaseConnector(
  config: DatabaseConnectorConfig,
): StatewaveConnector<DatabaseConnectorConfig, SourceRow> {
  validateConfig(config);
  const mode = config.mode ?? "rows";
  const sourceName = mode === "schema" ? "schema" : config.table ?? "query";
  const schemaTables: ReadonlyArray<TableRef> =
    mode === "schema" ? (config.tables ?? []).map(parseTableRef) : [];
  const mapperOptions: MapperOptions = {
    dialect: config.dialect,
    sourceName,
    idColumn: config.idColumn ?? "id",
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
      const sourceMsg =
        mode === "schema"
          ? `schema metadata for ${schemaTables.length} allowlisted table(s)`
          : config.table
            ? `table ${config.table}`
            : "query";
      return {
        connector: "database",
        status: "ok",
        details: [
          { name: "dialect", status: "ok", message: config.dialect },
          { name: "source", status: "ok", message: sourceMsg },
          {
            name: "mode",
            status: "ok",
            message:
              mode === "schema"
                ? "read-only; catalog metadata only; no data rows; allowlisted tables"
                : "read-only; SELECT-only; allowlisted columns/query",
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

      if (mode === "schema") {
        const schemaSubject = options.subject ?? config.subject;
        const episodes: StatewaveEpisode[] = [];
        for (const ref of schemaTables) {
          const table = await introspectTable(
            runner,
            config.connectionUrl,
            config.dialect,
            ref,
          );
          const ep = mapTableSchema(table, {
            dialect: config.dialect,
            subject: schemaSubject,
          });
          episodes.push(options.redaction ? redactEpisodeText(ep, options.redaction) : ep);
        }
        const dryRunSchema = !!options.dryRun;
        return {
          connector: "database",
          source: "database",
          subject: schemaSubject,
          episodes,
          ingested: dryRunSchema ? 0 : episodes.length,
          skipped: 0,
          dryRun: dryRunSchema,
          startedAt,
          finishedAt: new Date().toISOString(),
          summary: summarizeEpisodes(episodes, {
            tables_introspected: schemaTables.length,
          }),
        };
      }

      const since = options.since ? new Date(options.since).toISOString() : undefined;
      const maxRowsConfig = config.maxRows as number;
      const max = Math.min(maxRowsConfig, options.maxItems ?? maxRowsConfig);
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
      idColumn: config.idColumn!,
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

  const mode = config.mode ?? "rows";
  if (mode !== "rows" && mode !== "schema") {
    throw new ConnectorError(`unsupported mode "${String(mode)}"`, {
      code: "config_invalid",
      connector: "database",
      hint: "one of: rows (default), schema",
    });
  }
  if (mode === "schema") {
    if (!config.tables || config.tables.length === 0) {
      throw new ConnectorError(
        "schema mode requires a non-empty `tables` allowlist (no whole-instance crawl)",
        {
          code: "config_invalid",
          connector: "database",
          hint: "pass --tables table1,schema.table2 — schema mode never discovers un-listed tables",
        },
      );
    }
    // Validate every allowlist entry up front (identifiers + at most schema.table).
    for (const t of config.tables) parseTableRef(t);
    if (config.table || config.query || config.columns) {
      throw new ConnectorError(
        "schema mode does not take `table` / `query` / `columns` (those are row-mode, data-reading options)",
        {
          code: "config_invalid",
          connector: "database",
          hint: "schema mode reads catalog metadata for `tables` only and never reads data rows",
        },
      );
    }
    return;
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
  if (!config.idColumn) {
    throw new ConnectorError("idColumn is required in rows mode", {
      code: "config_invalid",
      connector: "database",
    });
  }
  assertIdentifier(config.idColumn, "idColumn");
  if (config.updatedAtColumn) assertIdentifier(config.updatedAtColumn, "updatedAtColumn");
  if (config.subjectColumn) assertIdentifier(config.subjectColumn, "subjectColumn");
  if (!Number.isInteger(config.maxRows) || (config.maxRows as number) <= 0) {
    throw new ConnectorError(`maxRows must be a positive integer (got ${config.maxRows})`, {
      code: "config_invalid",
      connector: "database",
    });
  }
}
