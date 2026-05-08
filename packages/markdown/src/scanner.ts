import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
]);

const MD_EXT = new Set([".md", ".mdx"]);

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  hash: string;
  size: number;
  mtime: string;
  content: string;
}

export interface ScanOptions {
  ignore?: ReadonlyArray<string>;
}

export async function scanMarkdownFolder(
  root: string,
  options: ScanOptions = {},
): Promise<ScannedFile[]> {
  const ignore = new Set([...DEFAULT_IGNORE, ...(options.ignore ?? [])]);
  const out: ScannedFile[] = [];
  const absRoot = path.resolve(root);
  await walk(absRoot, absRoot, ignore, out);
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}

async function walk(
  root: string,
  dir: string,
  ignore: Set<string>,
  out: ScannedFile[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, ignore, out);
    } else if (entry.isFile() && MD_EXT.has(path.extname(entry.name).toLowerCase())) {
      const stat = await fs.stat(full);
      const content = await fs.readFile(full, "utf8");
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
      out.push({
        absolutePath: full,
        relativePath: path.relative(root, full),
        hash,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        content,
      });
    }
  }
}
