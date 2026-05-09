// Event-ID dedup for Slack Events-API webhooks.
//
// Slack retries event delivery up to three times if it doesn't receive a
// 200 within 3 seconds, with `X-Slack-Retry-Num` and the SAME `event_id`
// on every retry. To avoid double-ingesting the same Slack message we
// keep a small set of recently-seen event ids in memory; if we see one
// again we ack the request without re-running the ingest path.
//
// The default in-memory cache fits ~10k recent events with a hard
// upper bound — enough to span Slack's retry window (a few minutes) on
// any sane workspace volume. Production deployments that span multiple
// processes (e.g. behind a load balancer) should plug in a shared
// implementation backed by Redis or Postgres.

export interface SlackDedupCache {
  /** Returns true if `eventId` has been seen before. The act of asking
   * also marks the id as seen, so the contract is "first call wins". */
  seenOrMark(eventId: string): boolean | Promise<boolean>;
}

export interface InMemoryDedupCacheOptions {
  /** Hard upper bound on the in-memory set. Older entries are evicted in
   * insertion order when the limit is reached. */
  maxEntries?: number;
}

/**
 * Simple in-memory dedup cache. Single-process — every Vercel cold start
 * or Cloudflare Worker isolate gets a fresh map. That's fine for the
 * common case because Slack retries are concentrated in the seconds
 * after the first delivery; if the next retry hits a different process
 * we'll re-ingest, and the server's own dedup (subject_id + type +
 * source + payload) absorbs it. Production cross-process deployments
 * should provide their own SlackDedupCache.
 */
export class InMemoryDedupCache implements SlackDedupCache {
  private readonly maxEntries: number;
  private readonly seen = new Set<string>();

  constructor(options: InMemoryDedupCacheOptions = {}) {
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
