// Event dedup for the Jira webhook receiver. Same shape as the
// Slack/Freshdesk/Zendesk/Intercom caches; kept per-package for now to avoid a
// breaking change in connectors-core, consolidated when the count earns it.

export interface JiraDedupCache {
  /** Returns true if `eventId` has been seen before. Asking also marks it as
   * seen, so the contract is "first call wins". */
  seenOrMark(eventId: string): boolean | Promise<boolean>;
}

export interface InMemoryJiraDedupCacheOptions {
  /** Hard upper bound on the in-memory set. Oldest entries evict first. */
  maxEntries?: number;
}

/**
 * Single-process in-memory dedup cache. Right default for one `listen jira`
 * daemon; deployments behind a load balancer should plug in a shared
 * `JiraDedupCache` (Redis, Postgres, etc.).
 */
export class InMemoryJiraDedupCache implements JiraDedupCache {
  private readonly maxEntries: number;
  private readonly seen = new Set<string>();

  constructor(options: InMemoryJiraDedupCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  seenOrMark(eventId: string): boolean {
    if (this.seen.has(eventId)) return true;
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(eventId);
    return false;
  }
}
