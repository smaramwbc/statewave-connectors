// Event-id dedup for Zendesk webhook receivers. Same shape as the
// Freshdesk and Slack caches; we keep them per-package for now to avoid
// a breaking change in connectors-core, and consolidate when the third
// receiver lands.

export interface ZendeskDedupCache {
  /** Returns true if `eventId` has been seen before. The act of asking
   * also marks the id as seen, so the contract is "first call wins". */
  seenOrMark(eventId: string): boolean | Promise<boolean>;
}

export interface InMemoryZendeskDedupCacheOptions {
  /** Hard upper bound on the in-memory set. Older entries are evicted
   * in insertion order when the limit is reached. */
  maxEntries?: number;
}

/**
 * Single-process in-memory dedup cache. Right default for a single
 * `listen zendesk` daemon; production deployments behind a load balancer
 * should plug in a shared `ZendeskDedupCache` (Redis, Postgres, etc.).
 */
export class InMemoryZendeskDedupCache implements ZendeskDedupCache {
  private readonly maxEntries: number;
  private readonly seen = new Set<string>();

  constructor(options: InMemoryZendeskDedupCacheOptions = {}) {
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
