import { describe, it, expect } from "vitest";
import {
  openRedisPullCursorStore,
  type RedisClientLike,
} from "../src/state/redis.js";

function makeFakeClient(): RedisClientLike & {
  hashes: Map<string, Map<string, string>>;
  ended: boolean;
} {
  const hashes = new Map<string, Map<string, string>>();
  let ended = false;
  return {
    hashes,
    get ended() {
      return ended;
    },
    async hget(key: string, field: string): Promise<string | null> {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hset(key: string, field: string, value: string): Promise<unknown> {
      let h = hashes.get(key);
      if (!h) {
        h = new Map();
        hashes.set(key, h);
      }
      h.set(field, value);
      return 1;
    },
    async quit(): Promise<unknown> {
      ended = true;
      return "OK";
    },
  };
}

describe("openRedisPullCursorStore", () => {
  it("returns undefined for unknown keys (cold start)", async () => {
    const client = makeFakeClient();
    const store = await openRedisPullCursorStore({ client });
    expect(await store.get("github", "main")).toBeUndefined();
  });

  it("set + get round-trips through HSET / HGET", async () => {
    const client = makeFakeClient();
    const store = await openRedisPullCursorStore({ client });
    await store.set("github", "main", "cursor-1");
    expect(await store.get("github", "main")).toBe("cursor-1");
    expect(client.hashes.get("statewave_runner:cursors")?.get("github/main")).toBe(
      "cursor-1",
    );
  });

  it("uses the default key_prefix when none configured", async () => {
    const client = makeFakeClient();
    const store = await openRedisPullCursorStore({ client });
    await store.set("github", "main", "x");
    expect(client.hashes.has("statewave_runner:cursors")).toBe(true);
  });

  it("respects the configured key_prefix", async () => {
    const client = makeFakeClient();
    const store = await openRedisPullCursorStore({ client, key_prefix: "myapp:" });
    await store.set("github", "main", "x");
    expect(client.hashes.has("myapp:cursors")).toBe(true);
    expect(client.hashes.has("statewave_runner:cursors")).toBe(false);
  });

  it("close() quits the client", async () => {
    const client = makeFakeClient();
    const store = await openRedisPullCursorStore({ client });
    expect(client.ended).toBe(false);
    await store.close();
    expect(client.ended).toBe(true);
  });

  it("rejects when neither url nor client is supplied", async () => {
    await expect(openRedisPullCursorStore({})).rejects.toThrow(/url is required/);
  });

  it("two kinds with the same name don't collide (different hash field)", async () => {
    const client = makeFakeClient();
    const store = await openRedisPullCursorStore({ client });
    await store.set("github", "primary", "g");
    await store.set("markdown", "primary", "m");
    expect(await store.get("github", "primary")).toBe("g");
    expect(await store.get("markdown", "primary")).toBe("m");
  });
});
