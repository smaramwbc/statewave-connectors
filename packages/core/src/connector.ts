import type { StatewaveEpisode } from "./episode.js";
import type { RedactionOptions } from "./redaction.js";
import type { SourceStateStore } from "./source-state.js";

export interface ConnectorConfig {
  statewaveUrl?: string;
  statewaveApiKey?: string;
  statewaveTenantId?: string;
  stateStore?: SourceStateStore;
}

export interface SyncOptions {
  subject?: string;
  since?: string | Date;
  maxItems?: number;
  dryRun?: boolean;
  include?: ReadonlyArray<string>;
  exclude?: ReadonlyArray<string>;
  redaction?: RedactionOptions;
  json?: boolean;
  cursor?: string;
}

export interface SyncSummary {
  /** Total mapped episodes (== episodes.length but kept explicit for JSON consumers). */
  total: number;
  /** Histogram of episode kinds → count. Stable shape for analytics. */
  kinds: Record<string, number>;
  /** Optional connector-specific per-source counters (e.g. files scanned vs mapped). */
  details?: Record<string, number>;
}

export interface SyncResult {
  connector: string;
  source: string;
  subject?: string;
  episodes: ReadonlyArray<StatewaveEpisode>;
  cursor?: string;
  ingested: number;
  skipped: number;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  summary: SyncSummary;
}

export type ConnectorCheckStatus = "ok" | "warn" | "error";

export interface ConnectorCheckResult {
  connector: string;
  status: ConnectorCheckStatus;
  details: ReadonlyArray<{ name: string; status: ConnectorCheckStatus; message?: string }>;
}

export interface StatewaveConnector<TConfig = unknown, TEvent = unknown> {
  readonly id: string;
  readonly name: string;
  readonly source: string;

  configure(config: TConfig): Promise<void>;
  check(): Promise<ConnectorCheckResult>;
  sync(options: SyncOptions): Promise<SyncResult>;
  mapEvent(event: TEvent): Promise<StatewaveEpisode>;
}
