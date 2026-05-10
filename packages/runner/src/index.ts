export { createRunner } from "./runner.js";
export type {
  CreateRunnerOptions,
  Runner,
  RunnerDescription,
} from "./runner.js";
export { createLogger } from "./logger.js";
export type { Logger, LogLevel, CreateLoggerOptions } from "./logger.js";
export { createHttpIngest } from "./ingest.js";
export type { StatewaveIngest, CreateIngestOptions } from "./ingest.js";

// State adapters — the Wave 3 surface. Operators select via
// [runner.state] in the config; embedders can construct directly.
export { InMemoryPullCursorStore } from "./state/in-memory.js";
export type { InMemoryPullCursorStoreOptions } from "./state/in-memory.js";
export { openFileBackedPullCursorStore } from "./state/file.js";
export type { FileBackedPullCursorStoreOptions } from "./state/file.js";
export { openPostgresPullCursorStore } from "./state/postgres.js";
export type { PostgresPullCursorStoreOptions } from "./state/postgres.js";
export { openRedisPullCursorStore } from "./state/redis.js";
export type { RedisPullCursorStoreOptions } from "./state/redis.js";
export { selectPullCursorStore } from "./state/select.js";
export type { SelectStateOptions } from "./state/select.js";
export { isClosable } from "./state/types.js";
export type { ClosablePullCursorStore, PullCursorStore } from "./state/types.js";

// Metrics surface — Wave 5. Operators consume `/metrics` via HTTP;
// embedders can construct or share a registry.
export { createMetrics } from "./metrics/registry.js";
export type { CreateMetricsOptions, Metrics } from "./metrics/registry.js";
export { makeMetricsAuthCheck } from "./metrics/auth.js";
export type { MetricsAuthCheck } from "./metrics/auth.js";
