import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { GitContext } from "./types.js";
import { parseGitRemote } from "./subject.js";

/**
 * Read git context by parsing `.git/HEAD` and `.git/config` directly.
 *
 * We deliberately do *not* spawn `git`. The companion runs inside an editor
 * extension host that may be sandboxed, and `git` may not be on PATH. Parsing
 * the two well-specified plumbing files is robust, fast, and side-effect free.
 *
 * Worktrees / submodules store a `gitdir:` pointer in a `.git` *file* rather
 * than a directory; we follow that one indirection.
 */
export async function readGitContext(root: string): Promise<GitContext> {
  const empty: GitContext = {
    branch: null,
    remoteUrl: null,
    owner: null,
    repo: null,
    host: null,
  };

  let gitDir: string;
  try {
    const dotGit = path.join(root, ".git");
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) {
      gitDir = dotGit;
    } else {
      const pointer = await fs.readFile(dotGit, "utf8");
      const m = pointer.match(/gitdir:\s*(.+)\s*/);
      if (!m) return empty;
      gitDir = path.resolve(root, m[1]!.trim());
    }
  } catch {
    return empty;
  }

  const branch = await readBranch(gitDir);
  const remoteUrl = await readRemoteUrl(gitDir);
  const parsed = parseGitRemote(remoteUrl);

  return {
    branch,
    remoteUrl,
    owner: parsed?.owner ?? null,
    repo: parsed?.repo ?? null,
    host: parsed?.host ?? null,
  };
}

async function readBranch(gitDir: string): Promise<string | null> {
  try {
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return ref[1]!;
    // Detached HEAD — surface the short sha rather than nothing.
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 12);
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse `.git/config` for a remote URL. Prefers `origin`, then `upstream`,
 * then the first remote defined. The git config format is INI-like:
 *
 *   [remote "origin"]
 *       url = https://github.com/owner/repo.git
 */
async function readRemoteUrl(gitDir: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(gitDir, "config"), "utf8");
  } catch {
    return null;
  }

  const remotes = new Map<string, string>();
  let currentRemote: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[\s*remote\s+"([^"]+)"\s*\]$/);
    if (section) {
      currentRemote = section[1]!;
      continue;
    }
    if (trimmed.startsWith("[")) {
      currentRemote = null;
      continue;
    }
    if (currentRemote) {
      const url = trimmed.match(/^url\s*=\s*(.+)$/);
      if (url && !remotes.has(currentRemote)) {
        remotes.set(currentRemote, url[1]!.trim());
      }
    }
  }

  return (
    remotes.get("origin") ??
    remotes.get("upstream") ??
    remotes.values().next().value ??
    null
  );
}
