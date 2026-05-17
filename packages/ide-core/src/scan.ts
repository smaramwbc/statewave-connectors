import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ScannedWorkspaceFile, WorkspaceScan } from "./types.js";
import { DEFAULT_IGNORE_DIRS, classifyFile, isIgnored } from "./classify.js";

export interface ScanOptions {
  includeGlobs?: ReadonlyArray<string>;
  excludeGlobs?: ReadonlyArray<string>;
  /**
   * Largest file (bytes) to hash content for. Bigger files are still listed
   * and classified, just hashed by size+mtime so a 200MB asset never gets
   * read into memory. Default 1 MiB.
   */
  maxHashBytes?: number;
  /** Hard cap on files returned, oldest-first walk order. Default 5000. */
  maxFiles?: number;
}

const DEFAULT_MAX_HASH_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 5000;

/**
 * Walk a workspace folder and produce a classified, ignore-filtered file
 * list. Pure filesystem — no git, no network, no editor APIs. The VS Code
 * extension calls this; tests call it against fixture dirs.
 */
export async function scanWorkspace(
  root: string,
  options: ScanOptions = {},
): Promise<WorkspaceScan> {
  const absRoot = path.resolve(root);
  const maxHashBytes = options.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const counters = { visited: 0, ignored: 0 };
  const files: ScannedWorkspaceFile[] = [];

  await walk(absRoot, absRoot, options, maxHashBytes, maxFiles, counters, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    root: absRoot,
    folderName: path.basename(absRoot),
    files,
    filesVisited: counters.visited,
    filesIgnored: counters.ignored,
  };
}

async function walk(
  root: string,
  dir: string,
  options: ScanOptions,
  maxHashBytes: number,
  maxFiles: number,
  counters: { visited: number; ignored: number },
  out: ScannedWorkspaceFile[],
): Promise<void> {
  if (out.length >= maxFiles) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    if ((err as NodeJS.ErrnoException).code === "EACCES") return;
    throw err;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");

    if (entry.isSymbolicLink()) continue; // never follow symlinks while scanning

    if (entry.isDirectory()) {
      const include = options.includeGlobs ?? [];
      const forced = include.length > 0 && rel.length > 0 && pathUnderInclude(rel, include);
      if (DEFAULT_IGNORE_DIRS.has(entry.name) && !forced) {
        counters.ignored += 1;
        continue;
      }
      await walk(root, full, options, maxHashBytes, maxFiles, counters, out);
      continue;
    }

    if (!entry.isFile()) continue;
    counters.visited += 1;

    if (
      isIgnored(rel, {
        includeGlobs: options.includeGlobs,
        excludeGlobs: options.excludeGlobs,
      })
    ) {
      counters.ignored += 1;
      continue;
    }

    let size = 0;
    let mtime = new Date(0).toISOString();
    try {
      const stat = await fs.stat(full);
      size = stat.size;
      mtime = stat.mtime.toISOString();
    } catch {
      continue;
    }

    let hash: string;
    if (size <= maxHashBytes) {
      try {
        const buf = await fs.readFile(full);
        hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
      } catch {
        hash = sizeMtimeHash(rel, size, mtime);
      }
    } else {
      hash = sizeMtimeHash(rel, size, mtime);
    }

    out.push({
      relativePath: rel,
      absolutePath: full,
      hash,
      size,
      mtime,
      category: classifyFile(rel),
    });
  }
}

function sizeMtimeHash(rel: string, size: number, mtime: string): string {
  return createHash("sha256")
    .update(`${rel}|${size}|${mtime}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Would any include glob ever match something under this directory? Used so a
 * force-include like `dist/keep/**` re-enters an otherwise-ignored dir. This
 * is a conservative prefix check, not a full glob walk — over-descending is
 * cheap; missing a force-include is not.
 */
function pathUnderInclude(relDir: string, include: ReadonlyArray<string>): boolean {
  return include.some((g) => {
    const head = g.split(/[*?]/)[0] ?? "";
    if (!head) return true; // glob starts with a wildcard → could match anywhere
    return head.startsWith(relDir) || relDir.startsWith(head.replace(/\/+$/, ""));
  });
}
