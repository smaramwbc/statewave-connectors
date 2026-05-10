// Event-id dedup for Freshdesk webhook receivers.
//
// Freshdesk doesn't have a native retry guarantee like Slack's
// 3-attempts-with-same-event-id contract, but operators frequently
// front the webhook with their own queueing system (Cloudflare Queues,
// Lambda DLQs, etc.) that does retry. Plus a Freshdesk Automation
// firing twice on the same ticket-status change is normal during
// rule cascades. The dedup cache is the same shape Slack uses; we
// keep them per-package for now to avoid a breaking change in
// connectors-core, and consolidate when a third receiver lands.

export interface FreshdeskDedupCache {
  /** Returns true if `eventId` has been seen before. The act of asking
   * also marks the id as seen, so the contract is "first call wins". */
  seenOrMark(eventId: string): boolean | Promise<boolean>;
}

export interface InMemoryFreshdeskDedupCacheOptions {
  /** Hard upper bound on the in-memory set. Older entries are evicted
   * in insertion order when the limit is reached. */
  maxEntries?: number;
}

/**
 * Single-process in-memory dedup cache. Right default for a single
 * `listen freshdesk` daemon; production deployments behind a load
 * balancer should plug in a shared `FreshdeskDedupCache` (Redis,
 * Postgres, etc.).
 */
export class InMemoryFreshdeskDedupCache implements FreshdeskDedupCache {
  private readonly maxEntries: number;
  private readonly seen = new Set<string>();

  constructor(options: InMemoryFreshdeskDedupCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  seenOrMark(eventId: string): boolean {
    if (this.seen.has(eventId)) return true;
    if (this.seen.size >= this.maxEntries) {
      // FIFO eviction — Set iteration order is insertion order in JS.
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(eventId);
    return false;
  }
}
