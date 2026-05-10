// Wraps croner for cron strings and a plain setInterval for the
// human `every <N><unit>` shorthand. The runner doesn't care which is
// which — both produce the same `Schedule` shape with `start()` and
// `stop()`.
//
// The schedule string is already validated by `connectors-config` at
// load time, so the helpers here only re-parse to dispatch the right
// primitive. Anything that didn't match either form is a programming
// error, not an operator error.

import { Cron } from "croner";

export interface Schedule {
  /** Begin firing the callback. Idempotent (safe to call after start). */
  start(): void;
  /** Stop firing. Idempotent. */
  stop(): void;
}

const HUMAN_PATTERN = /^every\s+(\d+)\s*([smhd])$/i;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export interface MakeScheduleOptions {
  /** Schedule string. Either `every <N><s|m|h|d>` or a 5- or 6-field cron. */
  spec: string;
  /** Fired on each tick. The runner awaits this before scheduling the next
   * tick on the human form (no overlapping invocations); on cron form,
   * croner waits for completion within the same interval too. */
  onTick: () => Promise<void> | void;
  /** Diagnostic name used when croner / setTimeout report errors. */
  name: string;
  /** Logger for tick-level errors. */
  logger?: (level: "warn" | "error", msg: string, ctx?: unknown) => void;
}

export function makeSchedule(options: MakeScheduleOptions): Schedule {
  const human = HUMAN_PATTERN.exec(options.spec);
  if (human && human[1] && human[2]) {
    const unitMs = UNIT_MS[human[2].toLowerCase()];
    if (unitMs) {
      return makeIntervalSchedule({
        ms: Number(human[1]) * unitMs,
        onTick: options.onTick,
        name: options.name,
        logger: options.logger,
      });
    }
  }
  return makeCronSchedule({
    cron: options.spec,
    onTick: options.onTick,
    name: options.name,
    logger: options.logger,
  });
}

function makeIntervalSchedule(args: {
  ms: number;
  onTick: () => Promise<void> | void;
  name: string;
  logger?: MakeScheduleOptions["logger"];
}): Schedule {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await args.onTick();
    } catch (err) {
      args.logger?.("error", `[${args.name}] schedule tick threw`, { err: String(err) });
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (timer) return;
      // Don't fire eagerly on start — the runner has explicit
      // start-of-life semantics so a daemon restart doesn't cause a
      // thundering herd. The first tick lands one interval out.
      timer = setInterval(() => void tick(), args.ms);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

function makeCronSchedule(args: {
  cron: string;
  onTick: () => Promise<void> | void;
  name: string;
  logger?: MakeScheduleOptions["logger"];
}): Schedule {
  let job: Cron | undefined;
  let stopped = false;

  return {
    start() {
      if (job) return;
      job = new Cron(
        args.cron,
        {
          // croner serializes overlapping invocations by default
          // (`protect: true`) so a slow tick doesn't double-fire.
          protect: true,
          // Don't trigger immediately — same reasoning as the interval form.
          paused: false,
        },
        async () => {
          if (stopped) return;
          try {
            await args.onTick();
          } catch (err) {
            args.logger?.("error", `[${args.name}] schedule tick threw`, {
              err: String(err),
            });
          }
        },
      );
    },
    stop() {
      stopped = true;
      if (job) {
        job.stop();
        job = undefined;
      }
    },
  };
}
