// File-backed pull cursor store.
//
// Writes are atomic — write to a temp file in the same directory,
// fsync, then rename(2) over the destination. The whole-file rewrite
// is fine because cursor state is small (a few hundred bytes per
// source); rewriting on every set() is simpler than journaling and
// correct under concurrent writes via the per-instance write queue.
//
// Concurrency model:
//   - All `set()` calls are serialized through a single write lock
//     (Promise chain), so two ticks firing simultaneously don't race.
//   - `get()` reads from the in-memory snapshot the adapter loaded at
//     construction time and updated on each successful set(). It
//     never re-reads from disk, so a `get()` immediately after a
//     `set()` always sees the new value, regardless of fs latency.
//
// Cross-process safety: the adapter does NOT take a flock on the
// state file — operators running multiple writer processes against
// the same file would race. The expected deployment is one runner
// process per file. Multi-process operators should use Postgres or
// Redis instead. Documented in the runner README.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClosablePullCursorStore } from "./types.js";

/**
 * On-disk shape — versioned so future migrations are tractable. The
 * payload is `{ "github/main": "cursor-abc", ... }`. Adapter rejects
 * unknown versions on load (fail-fast — operator either rolled back
 * or hand-edited; either way, a clear error beats silent data loss).
 */
interface OnDisk {
  version: 1;
  cursors: Record<string, string>;
}

const CURRENT_VERSION = 1 as const;

export interface FileBackedPullCursorStoreOptions {
  /** Absolute or cwd-relative path where the JSON state file lives.
   * Parent directory is created on first write if missing. */
  path: string;
}

/**
 * Construct + warm-load the file-backed cursor store. Returns a
 * ready-to-use store instance; throws on unreadable / corrupt /
 * version-mismatched state files (operator-fixable conditions, not
 * silent recovery).
 */
export async function openFileBackedPullCursorStore(
  options: FileBackedPullCursorStoreOptions,
): Promise<ClosablePullCursorStore> {
  const filePath = path.resolve(options.path);
  const cursors = await loadInitialState(filePath);

  // Single-tick write queue — chains every set() onto the previous one
  // so writes never overlap. Per-key locking would be marginally
  // faster, but cursor traffic is at most a few writes per minute and
  // the simpler design is correct under contention.
  let writeChain: Promise<void> = Promise.resolve();

  return {
    get(kind: string, name: string): string | undefined {
      return cursors.get(`${kind}/${name}`);
    },
    set(kind: string, name: string, cursor: string): Promise<void> {
      const key = `${kind}/${name}`;
      cursors.set(key, cursor);
      writeChain = writeChain
        .catch(() => undefined) // a previous write failure shouldn't poison the chain
        .then(() => persist(filePath, cursors));
      return writeChain;
    },
    async close(): Promise<void> {
      // Drain any in-flight write before letting the runner exit so
      // the most recent cursor is safely on disk.
      try {
        await writeChain;
      } catch {
        // Surfaced via the write site — close() shouldn't re-throw.
      }
    },
  };
}

async function loadInitialState(filePath: string): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return new Map(); // first run — fine
    throw new Error(
      `failed to read cursor state file at ${filePath}: ${e.message}`,
      { cause: err },
    );
  }
  let parsed: OnDisk;
  try {
    parsed = JSON.parse(text) as OnDisk;
  } catch (err) {
    throw new Error(
      `cursor state file at ${filePath} is not valid JSON; refuse to overwrite. ` +
        `Inspect the file and either repair it or delete to start fresh.`,
      { cause: err },
    );
  }
  if (parsed.version !== CURRENT_VERSION) {
    throw new Error(
      `cursor state file at ${filePath} has unsupported version=${(parsed as { version: unknown }).version}. ` +
        `Expected version=${CURRENT_VERSION}. Either roll forward via a future migration or delete to start fresh.`,
    );
  }
  if (!parsed.cursors || typeof parsed.cursors !== "object") {
    throw new Error(
      `cursor state file at ${filePath} is missing the .cursors map; refuse to overwrite.`,
    );
  }
  return new Map(Object.entries(parsed.cursors));
}

async function persist(filePath: string, cursors: Map<string, string>): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const payload: OnDisk = {
    version: CURRENT_VERSION,
    cursors: Object.fromEntries(cursors),
  };
  // Random suffix on the temp file so two concurrent processes (which
  // we already document as unsupported) at least don't clobber each
  // other's temp files mid-write. The rename(2) is the atomic step.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmp, filePath);
}
