// Single-process in-memory cursor store. State is lost on restart —
// fine for development, tests, or the ephemeral case where losing
// progress is preferable to the operational complexity of a real
// store. The runner picks this when [runner.state] is omitted or
// `kind = "memory"`.

import type { PullCursorStore } from "./types.js";

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
