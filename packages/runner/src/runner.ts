// `createRunner(config)` — the public entry point.
//
// One call wires up everything: scheduled pulls for every
// `[[pull.<kind>]]` entry, an HTTP multiplex server hosting every
// `[[push.<kind>]]` receiver under `/<kind>/<name>/events`, plus
// `/healthz` + `/readyz`. Returns a `Runner` control object the caller
// uses to `start()` and (later) `stop()` gracefully.
//
// The CLI's `run` command is a thin wrapper that calls `createRunner`,
// installs SIGTERM/SIGINT handlers, and waits forever. Anyone embedding
// the runner in their own service (a Vercel-like platform, a Helm-
// deployed pod, a Fly app) calls the same factory and manages
// lifecycle themselves.

import type {
  PullConnectors,
  PushConnectors,
  StatewaveConnectorsConfig,
} from "@statewavedev/connectors-config";
import {
  InMemoryPullCursorStore,
  type PullCursorStore,
} from "./cursor-store.js";
import { createHttpServer, type RunnerHttpServer, type PushMount } from "./http-server.js";
import { createHttpIngest, type StatewaveIngest } from "./ingest.js";
import { createLogger, type Logger } from "./logger.js";
import {
  instantiatePullConnector,
  type PullConnectorKind,
} from "./pull-adapters.js";
import {
  instantiatePushHandler,
  type PushReceiverKind,
} from "./push-adapters.js";
import { makeSchedule, type Schedule } from "./schedule.js";

export interface CreateRunnerOptions {
  config: StatewaveConnectorsConfig;
  /**
   * Override the ingest sink. Defaults to the HTTP sink that POSTs to
   * `<statewave.url>/v1/episodes`. Useful for embedding the runner in
   * a process that already has its own statewave client.
   */
  ingest?: StatewaveIngest;
  /** Override the cursor store. Defaults to in-memory (Wave 3 brings
   * file/Postgres/Redis adapters using the same interface). */
  cursorStore?: PullCursorStore;
  /** Override the logger sink (e.g. for tests or to plug in a real log shipper). */
  logger?: Logger;
  /** Inject `fetch` for the default HTTP ingest. */
  fetchImpl?: typeof fetch;
}

export interface Runner {
  /** Start the HTTP server and arm every schedule. Resolves once the
   * server is listening and every schedule is armed. */
  start(): Promise<void>;
  /** Drain in-flight requests, stop schedules, close the server.
   * Resolves once everything is stopped. Idempotent. */
  stop(): Promise<void>;
  /** Diagnostic snapshot for `validate-config`-style summaries and tests. */
  describe(): RunnerDescription;
}

export interface RunnerDescription {
  pullSources: ReadonlyArray<{ kind: string; name: string; schedule: string }>;
  pushReceivers: ReadonlyArray<{ kind: string; name: string; path: string }>;
  bindAddress: { host: string; port: number };
}

export async function createRunner(options: CreateRunnerOptions): Promise<Runner> {
  const config = options.config;
  const logger =
    options.logger ?? createLogger({ format: config.runner.log_format ?? "json" });

  const ingest =
    options.ingest ??
    createHttpIngest({
      statewave: config.statewave,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

  const cursorStore = options.cursorStore ?? new InMemoryPullCursorStore();

  // ── Materialize schedules (one per pull source) ──
  const schedules: Array<Schedule> = [];
  const pullSources: Array<{ kind: string; name: string; schedule: string }> = [];
  if (config.pull) {
    for (const kindKey of Object.keys(config.pull) as Array<keyof PullConnectors>) {
      const entries = config.pull[kindKey];
      if (!entries) continue;
      for (const entry of entries) {
        const sourceTag = `pull:${kindKey}/${entry.name}`;
        const sourceLogger = logger.withSource(sourceTag);
        const schedule = makeSchedule({
          spec: entry.schedule,
          name: sourceTag,
          onTick: () =>
            runOneSync({
              kind: kindKey as PullConnectorKind,
              entry,
              cursorStore,
              ingest,
              logger: sourceLogger,
            }),
          logger: (level, msg, ctx) => sourceLogger[level](msg, ctx as Record<string, unknown>),
        });
        schedules.push(schedule);
        pullSources.push({
          kind: kindKey,
          name: entry.name,
          schedule: entry.schedule,
        });
      }
    }
  }

  // ── Mount push receivers ──
  const mounts: PushMount[] = [];
  const pushReceivers: Array<{ kind: string; name: string; path: string }> = [];
  if (config.push) {
    for (const kindKey of Object.keys(config.push) as Array<keyof PushConnectors>) {
      const entries = config.push[kindKey];
      if (!entries) continue;
      for (const entry of entries) {
        const handler = await instantiatePushHandler({
          kind: kindKey as PushReceiverKind,
          name: entry.name,
          config: entry,
          ingest,
          logger,
        });
        const path = `/${kindKey}/${entry.name}/events`;
        mounts.push({ kind: kindKey, name: entry.name, handler, path });
        pushReceivers.push({ kind: kindKey, name: entry.name, path });
      }
    }
  }

  const readinessRef = { ready: false };
  const server: RunnerHttpServer = createHttpServer({
    port: config.runner.port ?? 3000,
    host: config.runner.host ?? "0.0.0.0",
    mounts,
    logger,
    readinessRef,
  });

  let started = false;
  let stopped = false;
  let bindAddress: { host: string; port: number } = {
    host: config.runner.host ?? "0.0.0.0",
    port: config.runner.port ?? 3000,
  };

  return {
    async start() {
      if (started) return;
      started = true;
      logger.info("runner starting", {
        pull_sources: pullSources.length,
        push_receivers: pushReceivers.length,
      });
      bindAddress = await server.start();
      logger.info("http server listening", bindAddress as unknown as Record<string, unknown>);
      for (const s of schedules) s.start();
      for (const p of pullSources) {
        logger.info(`pull scheduled`, { kind: p.kind, name: p.name, schedule: p.schedule });
      }
      for (const p of pushReceivers) {
        logger.info(`push mounted`, { kind: p.kind, name: p.name, path: p.path });
      }
      readinessRef.ready = true;
      logger.info("runner ready");
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      readinessRef.ready = false;
      logger.info("runner stopping");
      for (const s of schedules) s.stop();
      await server.stop();
      logger.info("runner stopped");
    },
    describe() {
      return { pullSources, pushReceivers, bindAddress };
    },
  };
}

// ── Per-tick: load cursor, run sync, persist new cursor ───────────────────

interface RunOneSyncArgs {
  kind: PullConnectorKind;
  entry: { name: string; subject?: string; max_items?: number; dry_run?: boolean };
  cursorStore: PullCursorStore;
  ingest: StatewaveIngest;
  logger: Logger;
}

async function runOneSync(args: RunOneSyncArgs): Promise<void> {
  const { kind, entry } = args;
  args.logger.info("sync starting");
  let connector;
  try {
    connector = await instantiatePullConnector(kind, entry);
  } catch (err) {
    args.logger.error("connector load failed", { err: String(err) });
    return;
  }

  const cursor = await args.cursorStore.get(kind, entry.name);
  const dryRun = entry.dry_run ?? false;

  try {
    const result = await connector.sync({
      ...(entry.subject ? { subject: entry.subject } : {}),
      ...(entry.max_items !== undefined ? { maxItems: entry.max_items } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      dryRun,
    });

    if (!dryRun) {
      for (const episode of result.episodes) {
        try {
          await args.ingest(episode);
        } catch (err) {
          // One bad ingest shouldn't tank the whole tick; the connector
          // will produce the same episode-id on the next run thanks to
          // the existing idempotency contract, so we'll catch up.
          args.logger.error("ingest failed for episode", {
            episode_id: (episode as { id?: string }).id ?? "?",
            err: String(err),
          });
        }
      }
    }

    if (result.cursor !== undefined) {
      await args.cursorStore.set(kind, entry.name, result.cursor);
    }

    args.logger.info("sync complete", {
      episodes: result.episodes.length,
      ingested: dryRun ? 0 : result.episodes.length,
      dry_run: dryRun,
      cursor: result.cursor ?? null,
    });
  } catch (err) {
    args.logger.error("sync failed", { err: String(err) });
  }
}
