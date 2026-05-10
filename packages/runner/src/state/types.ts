// The single PullCursorStore interface every adapter (in-memory,
// file, Postgres, Redis) implements.
//
// All methods are async-shaped — the in-memory adapter happens to
// resolve synchronously, but file / Postgres / Redis can't, and the
// runner doesn't care which it gets. Type unions over `Promise<T> | T`
// keep the in-memory case ergonomic in tests without forcing every
// adapter to be sync.

export interface PullCursorStore {
  /** Returns the last-persisted cursor for `(kind, name)`, or undefined
   * on cold start (no prior tick has succeeded for this source). */
  get(kind: string, name: string): Promise<string | undefined> | string | undefined;
  /** Persist a new cursor. Called after a successful sync. The runner
   * awaits this before logging the tick complete, so a slow store
   * appears as latency on the tick — but the cursor is durable before
   * the next tick fires. */
  set(kind: string, name: string, cursor: string): Promise<void> | void;
}

/**
 * Lifecycle for adapters that hold external resources (DB pool, Redis
 * client). The in-memory adapter doesn't implement this; the runner
 * checks for it before calling. File / Postgres / Redis adapters
 * implement `close()` so `runner.stop()` can release resources cleanly.
 */
export interface ClosablePullCursorStore extends PullCursorStore {
  close(): Promise<void>;
}

export function isClosable(s: PullCursorStore): s is ClosablePullCursorStore {
  return typeof (s as ClosablePullCursorStore).close === "function";
}
