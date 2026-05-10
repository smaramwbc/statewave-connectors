// Wraps prom-client's Registry with typed accessors for every metric
// the runner emits. The runner's `runner.ts` constructs one Metrics
// instance at boot and passes it down to the pull scheduler and the
// push handler wrapper. Shared registry → one `/metrics` scrape gets
// every series in one round-trip.
//
// Why prom-client: it handles the boring parts (label cardinality
// guards, text-format encoding, percentile estimation for histograms)
// and ships default Node process metrics out of the box. Adding it as
// a regular dep is fine — operators running the runner expect to be
// able to scrape it.

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

/**
 * Public surface the runner uses. Mostly exists so tests can swap in
 * a stub registry without touching every call site.
 */
export interface Metrics {
  /** prom-client Registry instance — used by the HTTP `/metrics`
   * handler to encode all metrics in one go. */
  registry: Registry;

  // ── Pull-mode metrics (per source) ─────────────────────────────────
  pullTicksTotal(kind: string, name: string): void;
  pullEpisodesIngestedTotal(kind: string, name: string, n: number): void;
  pullEpisodesEmittedTotal(kind: string, name: string, n: number): void;
  pullErrorsTotal(kind: string, name: string, reason: string): void;
  pullLastSyncTimestamp(kind: string, name: string, epochSec: number): void;
  pullSyncDurationSec(kind: string, name: string, sec: number): void;

  // ── Push-mode metrics (per receiver) ────────────────────────────────
  pushDeliveriesTotal(kind: string, name: string): void;
  pushResponsesTotal(kind: string, name: string, status: number): void;
  pushHandlerErrorsTotal(kind: string, name: string): void;
  pushDeliveryDurationSec(kind: string, name: string, sec: number): void;

  // ── Runner-level gauges ─────────────────────────────────────────────
  setRunnerInfo(version: string, hostname: string): void;
  setSchedulesArmed(n: number): void;
  setPushReceiversMounted(n: number): void;
  setReadyState(ready: boolean): void;
}

export interface CreateMetricsOptions {
  /** Inject a pre-built registry (rare; tests share one across cases). */
  registry?: Registry;
  /** Skip the prom-client default Node process metrics (CPU, memory,
   * GC, event-loop lag). Defaults to false — operators usually want
   * them. */
  disableDefaultMetrics?: boolean;
}

export function createMetrics(options: CreateMetricsOptions = {}): Metrics {
  const registry = options.registry ?? new Registry();
  if (!options.disableDefaultMetrics) {
    collectDefaultMetrics({ register: registry });
  }

  const pullTicks = new Counter({
    name: "statewave_runner_pull_ticks_total",
    help: "Total pull-source schedule ticks fired (success + failure).",
    labelNames: ["kind", "name"],
    registers: [registry],
  });
  const pullEpisodesIngested = new Counter({
    name: "statewave_runner_pull_episodes_ingested_total",
    help: "Episodes successfully posted to the Statewave server (excludes dry-run ticks).",
    labelNames: ["kind", "name"],
    registers: [registry],
  });
  const pullEpisodesEmitted = new Counter({
    name: "statewave_runner_pull_episodes_emitted_total",
    help: "Episodes returned by `connector.sync()` (whether or not they made it to ingest).",
    labelNames: ["kind", "name"],
    registers: [registry],
  });
  const pullErrors = new Counter({
    name: "statewave_runner_pull_errors_total",
    help: "Pull-source errors, partitioned by failure reason (load / sync / ingest).",
    labelNames: ["kind", "name", "reason"],
    registers: [registry],
  });
  const pullLastSync = new Gauge({
    name: "statewave_runner_pull_last_sync_timestamp_seconds",
    help: "Unix timestamp of the most recent successful sync per source.",
    labelNames: ["kind", "name"],
    registers: [registry],
  });
  const pullSyncDuration = new Histogram({
    name: "statewave_runner_pull_sync_duration_seconds",
    help: "Duration of `connector.sync()` per pull source.",
    labelNames: ["kind", "name"],
    buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });

  const pushDeliveries = new Counter({
    name: "statewave_runner_push_deliveries_total",
    help: "Total HTTP requests received by each push receiver.",
    labelNames: ["kind", "name"],
    registers: [registry],
  });
  const pushResponses = new Counter({
    name: "statewave_runner_push_responses_total",
    help: "Push receiver responses, partitioned by HTTP status code.",
    labelNames: ["kind", "name", "status"],
    registers: [registry],
  });
  const pushHandlerErrors = new Counter({
    name: "statewave_runner_push_handler_errors_total",
    help: "Times a push receiver's handler threw an exception.",
    labelNames: ["kind", "name"],
    registers: [registry],
  });
  const pushDeliveryDuration = new Histogram({
    name: "statewave_runner_push_delivery_duration_seconds",
    help: "Wall-clock time the push receiver spent handling each delivery.",
    labelNames: ["kind", "name"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const runnerInfo = new Gauge({
    name: "statewave_runner_info",
    help: "Static metadata about this runner instance (always 1).",
    labelNames: ["version", "hostname"],
    registers: [registry],
  });
  const schedulesArmed = new Gauge({
    name: "statewave_runner_schedules_armed",
    help: "Number of pull-source schedules currently armed.",
    registers: [registry],
  });
  const pushReceiversMounted = new Gauge({
    name: "statewave_runner_push_receivers_mounted",
    help: "Number of push receivers mounted on the HTTP multiplex.",
    registers: [registry],
  });
  const readyState = new Gauge({
    name: "statewave_runner_ready",
    help: "1 when /readyz returns 200, 0 otherwise.",
    registers: [registry],
  });

  return {
    registry,
    pullTicksTotal: (kind, name) => pullTicks.inc({ kind, name }),
    pullEpisodesIngestedTotal: (kind, name, n) =>
      n > 0 && pullEpisodesIngested.inc({ kind, name }, n),
    pullEpisodesEmittedTotal: (kind, name, n) =>
      n > 0 && pullEpisodesEmitted.inc({ kind, name }, n),
    pullErrorsTotal: (kind, name, reason) =>
      pullErrors.inc({ kind, name, reason }),
    pullLastSyncTimestamp: (kind, name, epochSec) =>
      pullLastSync.set({ kind, name }, epochSec),
    pullSyncDurationSec: (kind, name, sec) =>
      pullSyncDuration.observe({ kind, name }, sec),
    pushDeliveriesTotal: (kind, name) => pushDeliveries.inc({ kind, name }),
    pushResponsesTotal: (kind, name, status) =>
      pushResponses.inc({ kind, name, status: String(status) }),
    pushHandlerErrorsTotal: (kind, name) =>
      pushHandlerErrors.inc({ kind, name }),
    pushDeliveryDurationSec: (kind, name, sec) =>
      pushDeliveryDuration.observe({ kind, name }, sec),
    setRunnerInfo: (version, hostname) =>
      runnerInfo.set({ version, hostname }, 1),
    setSchedulesArmed: (n) => schedulesArmed.set(n),
    setPushReceiversMounted: (n) => pushReceiversMounted.set(n),
    setReadyState: (ready) => readyState.set(ready ? 1 : 0),
  };
}
