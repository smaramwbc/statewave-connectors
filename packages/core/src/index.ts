export type {
  ConnectorConfig,
  SyncOptions,
  SyncResult,
  SyncSummary,
  ConnectorCheckResult,
  ConnectorCheckStatus,
  StatewaveConnector,
} from "./connector.js";

export { summarizeEpisodes } from "./summary.js";

export type { SourcePointer, StatewaveEpisode } from "./episode.js";

export { EpisodeBuilder } from "./episode-builder.js";
export type { EpisodeBuilderInput } from "./episode-builder.js";

export { ConnectorError } from "./errors.js";
export type { ConnectorErrorCode, ConnectorErrorOptions } from "./errors.js";

export { idempotencyKey, namespacedKey } from "./idempotency.js";

export { redact, redactEpisodeText } from "./redaction.js";
export type { RedactionOptions, RedactionRule } from "./redaction.js";

export { withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";

export {
  MemorySourceStateStore,
  FileSourceStateStore,
} from "./source-state.js";
export type { SourceState, SourceStateStore } from "./source-state.js";
