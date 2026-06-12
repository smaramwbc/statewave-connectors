import type { FileCategory } from "./types.js";
import { matchesAnyGlob } from "./glob.js";

/**
 * Directory names that are never scanned or watched unless a caller's
 * `includeGlobs` explicitly opts them back in. Mirrors the markdown
 * connector's ignore set, plus IDE/build noise.
 */
export const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".idea",
  ".vscode-test",
  ".gradle",
  "target",
  "vendor",
]);

/** Lockfiles are ignored by default — large, noisy, and not memory-worthy. */
const LOCKFILES: ReadonlySet<string> = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "composer.lock",
  "go.sum",
]);

/**
 * File-basename patterns that are runtime noise, not user content. Catch
 * editor atomic-save artifacts (one per save → doubles every signal) and
 * embedded-DB storage files that Docker volumes mount inside the workspace
 * (every WiredTiger journal write would otherwise become an episode).
 */
const DEFAULT_IGNORE_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /\.tmp\.\d+\.[A-Fa-f0-9]+$/i, // VS Code atomic save: foo.tsx.tmp.79326.fd858c66695b
  /\.swp$/i, // vim swap
  /\.swo$/i, // vim swap (alt)
  /^\.#/, // emacs lock file (basename)
  /\.(?:wt|mdb)$/i, // WiredTiger / LMDB storage
  /^WiredTiger(?:\.lock|HS\.wt|\.turtle.*|\.wt)?$/i,
  /^(?:mongod|postgres|postmaster)\.lock$/i,
];

/**
 * Directory-segment patterns for common Docker-Compose volume mounts that
 * end up inside the workspace dir. A bare set wouldn't work because the
 * dirs are often versioned (`meili_data_v1.12`, `pgdata-2024`), so this is
 * a regex list checked against each path segment.
 */
const DEFAULT_IGNORE_DIR_PATTERNS: ReadonlyArray<RegExp> = [
  /^data-node$/i,
  /^(?:mongo|mongodb)[-_]?data\b/i,
  /^(?:pg|postgres|postgresql)[-_]?data\b/i,
  /^(?:mysql|mariadb)[-_]?data\b/i,
  /^redis[-_]?data\b/i,
  /^elasticsearch[-_]?data\b/i,
  /^meili[-_]?data(?:_v\d+(?:\.\d+)*)?$/i,
  /^data\.ms$/i,
];

function matchesAnyRegex(s: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((re) => re.test(s));
}

/** Files that may hold credentials — never indexed, not even via includeGlobs. */
const SECRET_FILE_RE =
  /(?:^|\/)(?:\.env(?:\.[A-Za-z0-9_-]+)?|\.netrc|\.npmrc|\.pypirc|\.dockercfg|credentials|\.htpasswd|id_(?:rsa|ed25519|ecdsa|dsa)|.*\.(?:pem|key|p12|pfx|keystore|jks|asc|ppk))$/i;
/** …but obvious non-secret env templates are fine. */
const SECRET_FILE_ALLOW_RE = /(?:^|\/)\.env\.(?:example|sample|template|dist|defaults?)$/i;

export function isSecretFile(relativePath: string): boolean {
  const rel = relativePath.replace(/\\/g, "/");
  if (SECRET_FILE_ALLOW_RE.test(rel)) return false;
  return SECRET_FILE_RE.test(rel);
}

const POSIX = (p: string): string => p.replace(/\\/g, "/");

function basename(relativePath: string): string {
  const norm = POSIX(relativePath);
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/**
 * Should this path be skipped entirely?
 *
 * Order of precedence:
 *   0. secret files (`.env`, `*.pem`, keys…) — HARD ignore, not even
 *      `includeGlobs` can opt these in. Privacy is non-negotiable.
 *   1. `includeGlobs` force-includes (wins over every default ignore).
 *   2. default ignore directories.
 *   3. lockfiles.
 *   4. `excludeGlobs`.
 */
export function isIgnored(
  relativePath: string,
  opts: {
    includeGlobs?: ReadonlyArray<string>;
    excludeGlobs?: ReadonlyArray<string>;
  } = {},
): boolean {
  const rel = POSIX(relativePath);
  const include = opts.includeGlobs ?? [];
  const exclude = opts.excludeGlobs ?? [];

  if (isSecretFile(rel)) return true;

  if (include.length > 0 && matchesAnyGlob(rel, include)) return false;

  const segments = rel.split("/");
  for (const seg of segments.slice(0, -1)) {
    if (DEFAULT_IGNORE_DIRS.has(seg)) return true;
    if (matchesAnyRegex(seg, DEFAULT_IGNORE_DIR_PATTERNS)) return true;
  }
  // A top-level dir that is itself an ignored name (no trailing file part).
  if (segments.length === 1) {
    const top = segments[0]!;
    if (DEFAULT_IGNORE_DIRS.has(top)) return true;
    if (matchesAnyRegex(top, DEFAULT_IGNORE_DIR_PATTERNS)) return true;
  }

  const base = basename(rel);
  if (LOCKFILES.has(base)) return true;
  if (matchesAnyRegex(base, DEFAULT_IGNORE_FILE_PATTERNS)) return true;

  if (exclude.length > 0 && matchesAnyGlob(rel, exclude)) return true;

  return false;
}

const TEST_RE = /(?:^|\/)(?:tests?|__tests__|spec)\//i;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const CONFIG_FILE_RE =
  /(?:^|\/)(?:\.eslintrc|\.prettierrc|\.editorconfig|vitest\.config|jest\.config|babel\.config|rollup\.config|vite\.config|webpack\.config|tailwind\.config|\.env\.example|renovate\.json|\.npmrc|\.nvmrc)/i;
const SOURCE_EXT_RE =
  /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|kts|cs|cpp|cc|c|h|hpp|swift|php|scala|clj|ex|exs|sh|bash|zsh|sql|graphql|proto)$/i;

/**
 * Coarse, retrieval-oriented classification. Specific manifests and decision
 * docs win over generic categories so the project summary stays accurate.
 */
export function classifyFile(relativePath: string): FileCategory {
  const rel = POSIX(relativePath);
  const lower = rel.toLowerCase();
  const base = basename(lower);

  if (base === "readme.md" || base === "readme.mdx" || base === "readme") {
    return "readme";
  }
  if (base === "package.json") return "node-manifest";
  if (
    base === "pnpm-workspace.yaml" ||
    base === "lerna.json" ||
    base === "nx.json" ||
    base === "turbo.json" ||
    base === "rush.json"
  ) {
    return "workspace-manifest";
  }
  if (base.startsWith("tsconfig") && base.endsWith(".json")) return "tsconfig";
  if (
    base === "pyproject.toml" ||
    base === "setup.py" ||
    base === "setup.cfg" ||
    base === "requirements.txt" ||
    base === "pipfile" ||
    base === "environment.yml"
  ) {
    return "python-manifest";
  }
  if (base === "dockerfile" || base.endsWith(".dockerfile")) return "dockerfile";
  if (/^docker-compose.*\.ya?ml$/.test(base) || /^compose.*\.ya?ml$/.test(base)) {
    return "compose";
  }

  if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
    if (/(?:^|\/)adrs?(?:\/|[-_])/.test(lower) || /(?:^|\/)adr-?\d/.test(lower)) {
      return "adr";
    }
    if (/(?:^|\/)rfcs?(?:\/|[-_])/.test(lower) || /(?:^|\/)rfc-?\d/.test(lower)) {
      return "rfc";
    }
    if (lower.includes("decision") || lower.includes("architecture")) {
      return "decision";
    }
    return "doc";
  }

  if (TEST_RE.test(rel) || TEST_FILE_RE.test(base)) return "test";
  if (CONFIG_FILE_RE.test(rel)) return "config";
  if (SOURCE_EXT_RE.test(base)) return "source";
  return "other";
}

/** True for ADR / RFC / explicit decision docs — drives `ide.architecture.detected`. */
export function isArchitectureDoc(category: FileCategory): boolean {
  return category === "adr" || category === "rfc" || category === "decision";
}

/** True for any documentation surface — drives `ide.docs.detected`. */
export function isDocLike(category: FileCategory): boolean {
  return (
    category === "readme" ||
    category === "doc" ||
    category === "adr" ||
    category === "rfc" ||
    category === "decision"
  );
}
