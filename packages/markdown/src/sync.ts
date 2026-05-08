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
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { mapMarkdownFile } from "./mapper.js";
import { scanMarkdownFolder, type ScannedFile } from "./scanner.js";

export interface MarkdownConnectorConfig {
  root: string;
  subject?: string;
}

export function createMarkdownConnector(
  config: MarkdownConnectorConfig,
): StatewaveConnector<MarkdownConnectorConfig, ScannedFile> {
  const root = path.resolve(config.root);

  return {
    id: `markdown:${root}`,
    name: "Markdown",
    source: "markdown",

    async configure(_next: MarkdownConnectorConfig): Promise<void> {
      throw new ConnectorError("markdown connector is configured at construction time", {
        code: "unsupported",
        connector: "markdown",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      let exists = true;
      try {
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) exists = false;
      } catch {
        exists = false;
      }
      return {
        connector: "markdown",
        status: exists ? "ok" : "error",
        details: [
          {
            name: "root",
            status: exists ? "ok" : "error",
            message: exists ? root : `directory not found: ${root}`,
          },
        ],
      };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const subject = options.subject ?? config.subject;
      if (!subject) {
        throw new ConnectorError("markdown sync requires a subject", {
          code: "config_invalid",
          connector: "markdown",
          hint: "pass --subject repo:owner/name (or another stable subject)",
        });
      }

      const files = await scanMarkdownFolder(root);
      const since = options.since ? new Date(options.since) : undefined;
      let droppedByInclude = 0;
      let droppedByExclude = 0;
      let droppedBySince = 0;
      const filtered = files.filter((f) => {
        if (options.include && !matchesAny(f.relativePath, options.include)) {
          droppedByInclude += 1;
          return false;
        }
        if (options.exclude && matchesAny(f.relativePath, options.exclude)) {
          droppedByExclude += 1;
          return false;
        }
        if (since && new Date(f.mtime) < since) {
          droppedBySince += 1;
          return false;
        }
        return true;
      });
      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = filtered.slice(0, max);
      const droppedByMax = filtered.length - limited.length;

      const episodes: StatewaveEpisode[] = limited.map((file) => {
        const ep = mapMarkdownFile(file, { subject });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const finishedAt = new Date().toISOString();
      const details: Record<string, number> = {
        files_scanned: files.length,
        files_mapped: episodes.length,
        files_dropped_include: droppedByInclude,
        files_dropped_exclude: droppedByExclude,
        files_dropped_since: droppedBySince,
        files_dropped_max_items: droppedByMax,
      };
      return {
        connector: "markdown",
        source: "markdown",
        subject,
        episodes,
        ingested: dryRun ? 0 : episodes.length,
        skipped: files.length - episodes.length,
        dryRun,
        startedAt,
        finishedAt,
        summary: summarizeEpisodes(episodes, details),
      };
    },

    async mapEvent(file: ScannedFile): Promise<StatewaveEpisode> {
      const subject = config.subject;
      if (!subject) {
        throw new ConnectorError("markdown mapEvent requires a configured subject", {
          code: "config_invalid",
          connector: "markdown",
        });
      }
      return mapMarkdownFile(file, { subject });
    },
  };
}

function matchesAny(rel: string, patterns: ReadonlyArray<string>): boolean {
  return patterns.some((p) => rel.includes(p));
}
