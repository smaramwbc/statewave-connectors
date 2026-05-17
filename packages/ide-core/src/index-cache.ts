/**
 * Incremental-indexing cache. Persisted (serialized) into the extension's
 * `workspaceState` so re-indexing only reprocesses changed files and large
 * repos stay responsive across reloads. Pure + serializable.
 */
import type { ScannedWorkspaceFile } from "./types.js";

export const INDEX_CACHE_VERSION = 1;

export interface IndexCacheData {
  version: number;
  /** relativePath → short content hash. */
  files: Record<string, string>;
}

export interface ScanDiff {
  /** Files new or whose content hash changed — these need reprocessing. */
  changed: ScannedWorkspaceFile[];
  /** Paths present last time but gone now. */
  removed: string[];
  /** Count of files identical to last index (skipped). */
  unchanged: number;
  /** The cache snapshot to persist after this scan. */
  next: IndexCacheData;
}

export function emptyCache(): IndexCacheData {
  return { version: INDEX_CACHE_VERSION, files: {} };
}

/**
 * Compare a fresh scan against the persisted cache. A cache from an older
 * version (or absent) is treated as a full rebuild.
 */
export function diffScan(
  prev: IndexCacheData | undefined,
  files: ReadonlyArray<ScannedWorkspaceFile>,
): ScanDiff {
  const valid = prev && prev.version === INDEX_CACHE_VERSION ? prev : undefined;
  const prevFiles = valid?.files ?? {};
  const nextFiles: Record<string, string> = {};
  const changed: ScannedWorkspaceFile[] = [];
  let unchanged = 0;

  for (const f of files) {
    nextFiles[f.relativePath] = f.hash;
    if (prevFiles[f.relativePath] === f.hash) {
      unchanged++;
    } else {
      changed.push(f);
    }
  }

  const seen = new Set(files.map((f) => f.relativePath));
  const removed = Object.keys(prevFiles).filter((p) => !seen.has(p));

  return {
    changed,
    removed,
    unchanged,
    next: { version: INDEX_CACHE_VERSION, files: nextFiles },
  };
}

/** True when nothing changed since the last index (skip the whole pass). */
export function isCacheFresh(diff: ScanDiff): boolean {
  return diff.changed.length === 0 && diff.removed.length === 0;
}
