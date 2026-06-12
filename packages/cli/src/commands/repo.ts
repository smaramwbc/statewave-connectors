import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * Git-grounded repository identity.
 *
 * The subject a memory is stored under must reflect the *repository*, not the
 * directory quickstart happens to run in. Deriving `repo:<basename(cwd)>` (the
 * old behavior) produces nonsense like `repo:smaram` from a home directory and
 * never matches what the connectors use (`sync github --subject repo:owner/name`).
 *
 * Here we resolve identity from git itself: the work-tree root, then the remote
 * URL parsed into a canonical `repo:<path>` that matches the connector
 * convention. Repositories without a remote fall back to `repo:<root-basename>`,
 * surfaced as a local-only subject the caller can confirm. Directories that are
 * not git work-trees resolve to nothing — the caller must then ask the user
 * rather than invent a subject.
 */

export interface ParsedRemote {
  host: string;
  /** Normalized repo path after the host, e.g. "owner/repo", "org/project/repo". */
  path: string;
}

export interface RepoIdentity {
  /** Absolute work-tree root (from `git rev-parse --show-toplevel`). */
  root: string;
  /** Canonical Statewave subject, e.g. `repo:owner/name`. */
  subject: string;
  /** True when the subject came from a parsed remote (vs the local-only fallback). */
  fromRemote: boolean;
  remoteUrl?: string;
}

const stripGitSuffix = (p: string): string => p.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");

/**
 * Parse an SSH or HTTPS git remote into `{ host, path }`. Handles GitHub, GitLab
 * (incl. nested subgroups), Bitbucket, Gitea/Forgejo, and Azure DevOps
 * (`v3/` SSH prefix, `_git/` HTTPS segment, and legacy `<org>.visualstudio.com`).
 * Returns undefined for anything it can't confidently parse.
 */
export function parseRemoteUrl(raw: string): ParsedRemote | undefined {
  const url = raw.trim();
  if (!url) return undefined;

  let host: string;
  let path: string;

  // scp-like SSH (`git@host:owner/repo.git`) — has no `://`.
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/;
  const scpMatch = !url.includes("://") ? url.match(scp) : null;
  if (scpMatch) {
    host = scpMatch[1]!.toLowerCase();
    path = scpMatch[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  }

  path = stripGitSuffix(path);
  if (!host || !path) return undefined;

  if (host.includes("dev.azure.com") || host.endsWith("visualstudio.com")) {
    let segs = path.split("/").filter(Boolean);
    if (segs[0] === "v3") segs = segs.slice(1); // SSH form: v3/org/project/repo
    segs = segs.filter((s) => s !== "_git"); // HTTPS form: org/project/_git/repo
    if (host.endsWith("visualstudio.com") && segs.length === 2) {
      // Legacy <org>.visualstudio.com/project/_git/repo — org is the subdomain.
      segs = [host.split(".")[0]!, ...segs];
    }
    path = segs.join("/");
  }

  return path ? { host, path } : undefined;
}

/** `repo:<path>` from a remote URL, or undefined if it can't be parsed. */
export function subjectFromRemoteUrl(raw: string): string | undefined {
  const parsed = parseRemoteUrl(raw);
  return parsed ? `repo:${parsed.path}` : undefined;
}

/** Local-only subject for a repo with no usable remote: `repo:<basename(root)>`. */
export function localSubject(root: string): string {
  return `repo:${basename(root)}`;
}

/** Work-tree root for `cwd`, or undefined when not inside a git work-tree. */
export function gitRoot(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** The repo's remote URL — `origin` if present, else the first configured remote. */
export function gitRemoteUrl(root: string): string | undefined {
  const run = (args: string[]): string | undefined => {
    try {
      return (
        execFileSync("git", ["-C", root, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || undefined
      );
    } catch {
      return undefined;
    }
  };
  const origin = run(["remote", "get-url", "origin"]);
  if (origin) return origin;
  const first = run(["remote"])
    ?.split("\n")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return first ? run(["remote", "get-url", first]) : undefined;
}

/** Resolve full identity for a directory, or undefined if it isn't a git work-tree. */
export function resolveRepoIdentity(cwd: string): RepoIdentity | undefined {
  const root = gitRoot(cwd);
  if (!root) return undefined;
  const remoteUrl = gitRemoteUrl(root);
  const fromRemote = remoteUrl ? subjectFromRemoteUrl(remoteUrl) : undefined;
  return {
    root,
    subject: fromRemote ?? localSubject(root),
    fromRemote: Boolean(fromRemote),
    remoteUrl,
  };
}

// Directories never worth descending into when discovering repositories.
const DEFAULT_EXCLUDES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".gradle",
  ".m2",
  "Library",
  "Applications",
  ".Trash",
]);

export interface DiscoverOptions {
  maxDepth?: number;
  maxResults?: number;
  excludes?: Set<string>;
  /** Injectable for tests: returns identity for a found repo root. */
  identify?: (dir: string) => RepoIdentity | undefined;
  /** Injectable for tests: does `dir` contain a `.git` entry? */
  isRepo?: (dir: string) => boolean;
  /** Injectable for tests: list immediate subdirectory names of `dir`. */
  listDirs?: (dir: string) => string[];
}

export interface DiscoverResult {
  repos: RepoIdentity[];
  truncated: boolean;
}

/**
 * Bounded, breadth-first discovery of git repositories under `searchRoot`.
 * Never recurses into a repository (its nested `.git` and `node_modules` are
 * irrelevant) and never descends excluded or hidden directories. Stops at
 * `maxDepth` levels or once `maxResults` repos are found, reporting truncation.
 */
export function discoverRepos(searchRoot: string, opts: DiscoverOptions = {}): DiscoverResult {
  const maxDepth = opts.maxDepth ?? 3;
  const maxResults = opts.maxResults ?? 50;
  const excludes = opts.excludes ?? DEFAULT_EXCLUDES;
  const isRepo = opts.isRepo ?? ((dir: string) => existsSync(join(dir, ".git")));
  const identify = opts.identify ?? resolveRepoIdentity;
  const listDirs =
    opts.listDirs ??
    ((dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    });

  const repos: RepoIdentity[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: resolve(searchRoot), depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (isRepo(dir)) {
      const id = identify(dir);
      if (id && !seen.has(id.root)) {
        seen.add(id.root);
        repos.push(id);
        if (repos.length >= maxResults) {
          truncated = queue.length > 0;
          break;
        }
      }
      continue; // a repo's contents are not scanned for nested repos
    }
    if (depth >= maxDepth) continue;
    for (const name of listDirs(dir)) {
      if (name.startsWith(".") || excludes.has(name)) continue;
      queue.push({ dir: join(dir, name), depth: depth + 1 });
    }
  }

  return { repos, truncated };
}
