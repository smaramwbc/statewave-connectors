// Per-source cursor store the pull scheduler reads from / writes to
// across schedule fires.
//
// Wave 2 (this release) ships an in-memory implementation only. State
// is lost across restarts — operators see this in `validate-config`
// and the runner README, and Wave 3 brings the persistent file /
// Postgres / Redis adapters that share this same interface so plug-in
// is one config flip.
//
// The interface is async-shaped so the persistent adapters (which
// have to do real I/O) can drop in without changing every call site.

export interface PullCursorStore {
  /** Returns the last-persisted cursor for `(kind, name)`, or undefined
   * on cold start. */
  get(kind: string, name: string): Promise<string | undefined> | string | undefined;
  /** Persist a new cursor. Called after a successful sync. */
  set(kind: string, name: string, cursor: string): Promise<void> | void;
}

export interface InMemoryPullCursorStoreOptions {
  /** Seed values, useful for cold-start testing. Keyed by `${kind}/${name}`. */
  seed?: Record<string, string>;
}

export class InMemoryPullCursorStore implements PullCursorStore {
  private readonly cursors = new Map<string, string>();

  constructor(options: InMemoryPullCursorStoreOptions = {}) {
    if (options.seed) {
      for (const [k, v] of Object.entries(options.seed)) this.cursors.set(k, v);
    }
  }

  get(kind: string, name: string): string | undefined {
    return this.cursors.get(`${kind}/${name}`);
  }

  set(kind: string, name: string, cursor: string): void {
    this.cursors.set(`${kind}/${name}`, cursor);
  }
}
