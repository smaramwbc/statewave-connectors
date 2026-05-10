import { describe, it, expect } from "vitest";
import { InMemoryPullCursorStore } from "../src/cursor-store.js";

describe("InMemoryPullCursorStore", () => {
  it("returns undefined on cold start", () => {
    const store = new InMemoryPullCursorStore();
    expect(store.get("github", "main")).toBeUndefined();
  });

  it("set + get round-trips", () => {
    const store = new InMemoryPullCursorStore();
    store.set("github", "main", "cursor-123");
    expect(store.get("github", "main")).toBe("cursor-123");
  });

  it("keys (kind, name) — same name across kinds doesn't collide", () => {
    const store = new InMemoryPullCursorStore();
    store.set("github", "primary", "g-cursor");
    store.set("markdown", "primary", "m-cursor");
    expect(store.get("github", "primary")).toBe("g-cursor");
    expect(store.get("markdown", "primary")).toBe("m-cursor");
  });

  it("seeds from constructor", () => {
    const store = new InMemoryPullCursorStore({
      seed: { "github/main": "seeded", "gmail/inbox": "h-1" },
    });
    expect(store.get("github", "main")).toBe("seeded");
    expect(store.get("gmail", "inbox")).toBe("h-1");
  });

  it("set overwrites prior value", () => {
    const store = new InMemoryPullCursorStore();
    store.set("github", "main", "v1");
    store.set("github", "main", "v2");
    expect(store.get("github", "main")).toBe("v2");
  });
});
