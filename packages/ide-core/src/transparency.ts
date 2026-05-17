/**
 * "Why was this indexed / skipped?" — the transparency layer. Pure so the
 * answer the user sees exactly matches what `isIgnored` actually does.
 */
import {
  classifyFile,
  isSecretFile,
  DEFAULT_IGNORE_DIRS,
} from "./classify.js";
import { matchesAnyGlob } from "./glob.js";

export interface PathExplanation {
  path: string;
  indexed: boolean;
  reason: string;
}

const LOCKFILES = new Set([
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

function base(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

/** Explain a single path with the *same* precedence as `isIgnored`. */
export function explainPath(
  relativePath: string,
  opts: {
    includeGlobs?: ReadonlyArray<string>;
    excludeGlobs?: ReadonlyArray<string>;
  } = {},
): PathExplanation {
  const rel = relativePath.replace(/\\/g, "/");
  const include = opts.includeGlobs ?? [];
  const exclude = opts.excludeGlobs ?? [];

  if (isSecretFile(rel)) {
    return {
      path: rel,
      indexed: false,
      reason: "skipped — looks like a secret/credentials file (hard rule; never indexed, not even via includeGlobs)",
    };
  }
  if (include.length > 0 && matchesAnyGlob(rel, include)) {
    return { path: rel, indexed: true, reason: "indexed — explicitly opted in via includeGlobs" };
  }
  const segments = rel.split("/");
  for (const seg of segments.slice(0, -1)) {
    if (DEFAULT_IGNORE_DIRS.has(seg)) {
      return { path: rel, indexed: false, reason: `skipped — inside ignored directory "${seg}"` };
    }
  }
  if (segments.length === 1 && DEFAULT_IGNORE_DIRS.has(segments[0]!)) {
    return { path: rel, indexed: false, reason: "skipped — ignored directory" };
  }
  if (LOCKFILES.has(base(rel))) {
    return { path: rel, indexed: false, reason: "skipped — lockfile (noisy, not memory-worthy)" };
  }
  if (exclude.length > 0 && matchesAnyGlob(rel, exclude)) {
    return { path: rel, indexed: false, reason: "skipped — matches excludeGlobs" };
  }
  return { path: rel, indexed: true, reason: `indexed — classified as "${classifyFile(rel)}"` };
}

export interface TransparencyReport {
  indexed: PathExplanation[];
  skipped: PathExplanation[];
  byReason: Record<string, number>;
}

export function summarizeTransparency(
  relativePaths: ReadonlyArray<string>,
  opts: {
    includeGlobs?: ReadonlyArray<string>;
    excludeGlobs?: ReadonlyArray<string>;
  } = {},
): TransparencyReport {
  const indexed: PathExplanation[] = [];
  const skipped: PathExplanation[] = [];
  const byReason: Record<string, number> = {};
  for (const p of relativePaths) {
    const e = explainPath(p, opts);
    (e.indexed ? indexed : skipped).push(e);
    const key = e.reason.split(" — ")[0] ?? e.reason;
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  indexed.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { indexed, skipped, byReason };
}
