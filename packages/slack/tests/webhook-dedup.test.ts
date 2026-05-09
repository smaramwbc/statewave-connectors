import { describe, it, expect } from "vitest";
import { InMemoryDedupCache } from "../src/index.js";

describe("InMemoryDedupCache", () => {
  it("first observation returns false; subsequent ones return true", () => {
    const c = new InMemoryDedupCache();
    expect(c.seenOrMark("Ev1")).toBe(false);
    expect(c.seenOrMark("Ev1")).toBe(true);
    expect(c.seenOrMark("Ev1")).toBe(true);
  });

  it("distinct ids are independent", () => {
    const c = new InMemoryDedupCache();
    expect(c.seenOrMark("Ev1")).toBe(false);
    expect(c.seenOrMark("Ev2")).toBe(false);
    expect(c.seenOrMark("Ev1")).toBe(true);
    expect(c.seenOrMark("Ev2")).toBe(true);
  });

  it("evicts FIFO when the cap is reached", () => {
    // Each new id beyond maxEntries evicts the oldest. With cap=3 and a
    // 4-id sequence, the first id should fall out and the most recent
    // three should still be remembered.
    const c = new InMemoryDedupCache({ maxEntries: 3 });
    c.seenOrMark("a");
    c.seenOrMark("b");
    c.seenOrMark("c");
    c.seenOrMark("d");
    // Probe the *survivors* first, before any of these probes themselves
    // grow the set past the cap and evict each other.
    expect(c.seenOrMark("d")).toBe(true);
    expect(c.seenOrMark("c")).toBe(true);
    expect(c.seenOrMark("b")).toBe(true);
    // `a` was the oldest at the time of `d`'s insertion, so it got evicted.
    expect(c.seenOrMark("a")).toBe(false);
  });
});
