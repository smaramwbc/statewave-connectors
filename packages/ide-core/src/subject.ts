import type { IdeCompanionConfig } from "./types.js";

export interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parse the common git remote URL shapes into `{ host, owner, repo }`.
 *
 * Handles:
 *   - https://github.com/owner/repo(.git)
 *   - http://host/owner/repo
 *   - git@github.com:owner/repo.git           (scp-like)
 *   - ssh://git@github.com/owner/repo.git
 *   - git://github.com/owner/repo.git
 *   - nested groups (GitLab): host/group/subgroup/repo → owner = "group/subgroup"
 *
 * Returns null when the URL doesn't yield a host + owner + repo. We never
 * throw here: an unparseable remote just means we fall back to the
 * `workspace:` subject.
 */
export function parseGitRemote(url: string | null | undefined): ParsedRemote | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let host: string;
  let path: string;

  const scpLike = trimmed.match(/^[A-Za-z0-9._-]+@([^:/]+):(.+)$/);
  if (scpLike) {
    host = scpLike[1]!;
    path = scpLike[2]!;
  } else {
    const m = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
    if (!m) return null;
    host = m[1]!;
    path = m[2]!;
  }

  // Strip port, trailing slashes, and a trailing `.git`.
  host = host.replace(/:\d+$/, "").toLowerCase();
  path = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);

  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts[parts.length - 1]!;
  const owner = parts.slice(0, -1).join("/");
  if (!owner || !repo) return null;

  return { host, owner, repo };
}

const SUBJECT_UNSAFE = /[\s]+/g;

/** Normalise a folder name into a subject-safe slug. */
export function workspaceSlug(folderName: string): string {
  return folderName.trim().replace(SUBJECT_UNSAFE, "-").toLowerCase() || "workspace";
}

const SERVER_SUBJECT_DISALLOWED = /[^A-Za-z0-9_.:\-]/g;

/**
 * Make a subject ingestable by the Statewave server.
 *
 * The server validates `subject_id` against `^[A-Za-z0-9_.\-:]+$`. The
 * documented `repo:<owner>/<repo>` convention uses `/`, which the server
 * rejects (422). `/` is mapped to `.` so `repo:acme/widgets` becomes
 * `repo:acme.widgets` — still readable, still stable, and the same value an
 * agent queries. Anything else outside the allowed set collapses to `-` so a
 * subject is *always* ingestable, never a surprise 422 at click time.
 */
export function sanitizeSubjectId(subject: string): string {
  return subject.replace(/\//g, ".").replace(SERVER_SUBJECT_DISALLOWED, "-");
}

export interface ResolveSubjectInput {
  config: Pick<IdeCompanionConfig, "subjectStrategy" | "customSubject">;
  remoteUrl?: string | null;
  folderName: string;
}

/**
 * Resolve the Statewave subject for this workspace.
 *
 *   - `custom`    → the configured `customSubject` verbatim (validated non-empty)
 *   - `repo`      → `repo:<owner>/<repo>` (errors out via null if no remote)
 *   - `workspace` → `workspace:<folder-slug>`
 *   - `auto`      → `repo:<owner>/<repo>` when a remote parses, else
 *                   `workspace:<folder-slug>`
 *
 * Returns null only when `repo`/`custom` were requested but unsatisfiable —
 * the caller surfaces that as actionable config guidance rather than
 * silently picking a surprising subject.
 */
export function resolveSubject(input: ResolveSubjectInput): string | null {
  const { config } = input;
  const strategy = config.subjectStrategy;

  if (strategy === "custom") {
    const s = config.customSubject?.trim();
    return s ? sanitizeSubjectId(s) : null;
  }

  const parsed = parseGitRemote(input.remoteUrl);

  if (strategy === "repo") {
    return parsed ? sanitizeSubjectId(`repo:${parsed.owner}/${parsed.repo}`) : null;
  }

  if (strategy === "workspace") {
    return sanitizeSubjectId(`workspace:${workspaceSlug(input.folderName)}`);
  }

  // auto
  return sanitizeSubjectId(
    parsed
      ? `repo:${parsed.owner}/${parsed.repo}`
      : `workspace:${workspaceSlug(input.folderName)}`,
  );
}
