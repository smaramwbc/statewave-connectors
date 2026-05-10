// Redis-backed pull cursor store.
//
// State lives in a single Redis hash at `<key_prefix>cursors`. Each
// `(kind, name)` pair maps to one hash field `kind/name`. `get()` is
// `HGET`, `set()` is `HSET`. Single round-trip per operation; atomic.
//
// `ioredis` is an OPTIONAL peer dependency — operators using other
// state kinds don't pay the install cost. The adapter dynamically
// imports it so the absence is detected at adapter construction time
// (a clear error message), not at module load.
//
// Why Redis hashes (vs per-key strings)? One `HGETALL` lets the runner
// debug-dump the full cursor state in one round-trip; key-prefix
// scanning works on standalone Redis but is awkward on Cluster. The
// hash also makes the keyspace footprint trivial (one parent key,
// regardless of source count).

import type { ClosablePullCursorStore } from "./types.js";

export interface RedisPullCursorStoreOptions {
  /** Redis connection URL, e.g. `redis://localhost:6379`. Required
   * unless `client` is injected. */
  url?: string;
  /** Prefix for the runner's keys. Default `statewave_runner:`. The
   * adapter writes a single hash at `<prefix>cursors`. */
  key_prefix?: string;
  /**
   * Inject a pre-built `ioredis`-compatible client. When provided, the
   * adapter skips the dynamic `ioredis` import — useful for tests and
   * for embedders who already maintain their own client. The client's
   * `hget`, `hset`, and `quit` are the only surface the adapter calls.
   */
  client?: RedisClientLike;
}

/**
 * Minimal interface the adapter calls — narrower than the real ioredis
 * type so the adapter doesn't need `@types/ioredis` at build time.
 */
export interface RedisClientLike {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

const DEFAULT_KEY_PREFIX = "statewave_runner:";

/**
 * Connect to Redis and return a ready-to-use store. Throws if
 * `ioredis` isn't installed or the URL is unreachable.
 */
export async function openRedisPullCursorStore(
  options: RedisPullCursorStoreOptions,
): Promise<ClosablePullCursorStore> {
  const prefix = options.key_prefix ?? DEFAULT_KEY_PREFIX;
  const hashKey = `${prefix}cursors`;

  let client: RedisClientLike;
  if (options.client) {
    client = options.client;
  } else {
    if (!options.url) {
      throw new Error("redis state adapter: url is required when client is not injected");
    }
    type IoRedisModule = { default: new (url: string) => RedisClientLike };
    let ioredisModule: IoRedisModule;
    try {
      // Same indirect trick as the postgres adapter — ioredis is an
      // optional peer, so its type package shouldn't be a hard build
      // requirement.
      const moduleName = "ioredis";
      ioredisModule = (await import(moduleName)) as unknown as IoRedisModule;
    } catch {
      throw new Error(
        `redis state adapter requires the optional peer dependency \`ioredis\`. ` +
          `Install it: \`npm install ioredis\` (or pnpm/yarn). ` +
          `The runner only loads ioredis when [runner.state] kind = "redis".`,
      );
    }
    client = new ioredisModule.default(options.url);
  }

  return {
    async get(kind: string, name: string): Promise<string | undefined> {
      const raw = await client.hget(hashKey, `${kind}/${name}`);
      return raw ?? undefined;
    },
    async set(kind: string, name: string, cursor: string): Promise<void> {
      await client.hset(hashKey, `${kind}/${name}`, cursor);
    },
    async close(): Promise<void> {
      await client.quit();
    },
  };
}
