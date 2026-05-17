/**
 * Async compile orchestration.
 *
 * Compilation is the "raw episodes → retrievable memory" pass. It must never
 * block the UI and must be deterministic, so this is an explicit state
 * machine with debounce + min-interval throttle. The extension calls
 * `request(reason)` on the freshness triggers (ingest finished, window focus,
 * assistant wrote a fact, idle elapsed); the scheduler coalesces them.
 *
 * Pure/injectable: timers and the compile function are passed in, so the
 * state transitions are unit-testable with a fake clock.
 */

export type CompileState =
  | "idle"
  | "pending"
  | "compiling"
  | "ready"
  | "failed";

export type CompileReason =
  | "ingest-completed"
  | "focus"
  | "assistant-wrote"
  | "idle-interval"
  | "manual";

export interface CompileSnapshot {
  state: CompileState;
  lastReason?: CompileReason;
  lastCompiledAt?: number;
  lastError?: string;
  /** A request arrived and a compile is owed. */
  dirty: boolean;
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface CompileSchedulerOptions {
  /** Performs the actual compile (extension wraps StatewaveClient). */
  compile: (reason: CompileReason) => Promise<void>;
  /** Quiet period after the last request before compiling. Default 1500ms. */
  debounceMs?: number;
  /** Never start two compiles closer than this. Default 30000ms. */
  minIntervalMs?: number;
  timers?: Timers;
  onChange?: (snap: CompileSnapshot) => void;
}

export class CompileScheduler {
  private state: CompileState = "idle";
  private lastReason?: CompileReason;
  private lastCompiledAt?: number;
  private lastError?: string;
  private dirty = false;
  private timer: unknown;
  private rerunReason?: CompileReason;
  private readonly o: Required<Omit<CompileSchedulerOptions, "onChange">> &
    Pick<CompileSchedulerOptions, "onChange">;

  constructor(options: CompileSchedulerOptions) {
    this.o = {
      compile: options.compile,
      debounceMs: options.debounceMs ?? 1500,
      minIntervalMs: options.minIntervalMs ?? 30000,
      timers: options.timers ?? realTimers,
      onChange: options.onChange,
    };
  }

  snapshot(): CompileSnapshot {
    return {
      state: this.state,
      lastReason: this.lastReason,
      lastCompiledAt: this.lastCompiledAt,
      lastError: this.lastError,
      dirty: this.dirty,
    };
  }

  private emit(): void {
    this.o.onChange?.(this.snapshot());
  }

  /** Ask for a compile. Coalesced + throttled; never throws, never blocks. */
  request(reason: CompileReason): void {
    this.lastReason = reason;
    if (this.state === "compiling") {
      // Something changed mid-compile — run again afterwards.
      this.dirty = true;
      this.rerunReason = reason;
      this.emit();
      return;
    }
    this.dirty = true;
    this.state = "pending";
    this.emit();
    this.arm(reason);
  }

  private arm(reason: CompileReason): void {
    if (this.timer) this.o.timers.clearTimeout(this.timer);
    const sinceLast = this.lastCompiledAt
      ? this.o.timers.now() - this.lastCompiledAt
      : Number.POSITIVE_INFINITY;
    const wait = Math.max(
      this.o.debounceMs,
      this.o.minIntervalMs - sinceLast,
      0,
    );
    this.timer = this.o.timers.setTimeout(() => void this.fire(reason), wait);
  }

  private async fire(reason: CompileReason): Promise<void> {
    this.timer = undefined;
    this.state = "compiling";
    this.dirty = false;
    this.emit();
    try {
      await this.o.compile(reason);
      this.lastCompiledAt = this.o.timers.now();
      this.lastError = undefined;
      this.state = "ready";
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.state = "failed";
    }
    this.emit();
    if (this.dirty || this.rerunReason) {
      const r = this.rerunReason ?? reason;
      this.rerunReason = undefined;
      this.request(r);
    }
  }

  /** Drop a pending (not-yet-started) compile. A running one finishes. */
  cancelPending(): void {
    if (this.timer) {
      this.o.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.state === "pending") {
      this.state = this.lastCompiledAt ? "ready" : "idle";
      this.emit();
    }
  }

  dispose(): void {
    if (this.timer) this.o.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
