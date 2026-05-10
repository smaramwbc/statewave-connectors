// Cursor + delivery dedup state for the Gmail Pub/Sub receiver.
//
// Two pieces of state are needed across deliveries:
//
// 1. **History cursor** — the highest `historyId` we've successfully
//    processed for a given mailbox. The next Pub/Sub delivery starts
//    its History API walk from this value, so deltas don't get
//    double-emitted across restarts. Keyed by `emailAddress` since
//    operators occasionally watch multiple mailboxes from one daemon.
//
// 2. **Pub/Sub messageId dedup** — Cloud Pub/Sub guarantees at-least-
//    once delivery, so the same `messageId` can be redelivered after
//    transient failures. We dedup by it so retries don't refetch the
//    same history window.
//
// Both interfaces are pluggable so production deploys can replace the
// in-memory defaults with Redis / Postgres / etc.

export interface GmailHistoryCursorStore {
  /** Read the last-persisted historyId for a mailbox. Returns undefined
   * on cold start (no prior delivery). */
  get(emailAddress: string): Promise<string | undefined> | string | undefined;
  /** Persist a new historyId for a mailbox. Called after a successful
   * delivery so subsequent runs start from this value. */
  set(emailAddress: string, historyId: string): Promise<void> | void;
}

export interface GmailPubsubDedupCache {
  /** Returns true if `messageId` has been seen before. The act of
   * asking also marks the id as seen, so the contract is "first call
   * wins". */
  seenOrMark(messageId: string): boolean | Promise<boolean>;
}

export interface InMemoryGmailHistoryCursorStoreOptions {
  /** Seed values, useful for cold-start testing. */
  seed?: Record<string, string>;
}

/** Single-process in-memory history cursor store. */
export class InMemoryGmailHistoryCursorStore implements GmailHistoryCursorStore {
  private readonly cursors = new Map<string, string>();

  constructor(options: InMemoryGmailHistoryCursorStoreOptions = {}) {
    if (options.seed) {
      for (const [k, v] of Object.entries(options.seed)) this.cursors.set(k, v);
    }
  }

  get(emailAddress: string): string | undefined {
    return this.cursors.get(emailAddress);
  }

  set(emailAddress: string, historyId: string): void {
    this.cursors.set(emailAddress, historyId);
  }
}

export interface InMemoryGmailPubsubDedupCacheOptions {
  /** Hard upper bound on the in-memory set. Older entries are evicted
   * in insertion order when the limit is reached. */
  maxEntries?: number;
}

/** Single-process in-memory dedup cache. Same shape as the other Tier 2 receivers. */
export class InMemoryGmailPubsubDedupCache implements GmailPubsubDedupCache {
  private readonly maxEntries: number;
  private readonly seen = new Set<string>();

  constructor(options: InMemoryGmailPubsubDedupCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  seenOrMark(messageId: string): boolean {
    if (this.seen.has(messageId)) return true;
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(messageId);
    return false;
  }
}
