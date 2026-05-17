/**
 * Editor-independent types for the Statewave IDE Companion.
 *
 * Nothing in `@statewavedev/ide-core` imports `vscode`. The VS Code / Cursor
 * extension is a thin host that turns editor events into these shapes and
 * hands them to the helpers here. That keeps all of the interesting logic
 * unit-testable without an extension host.
 */

/** The seven canonical IDE episode kinds. Dotted, `ide`-prefixed — see docs/episode-schema.md. */
export type IdeEpisodeKind =
  | "ide.workspace.indexed"
  | "ide.file.changed"
  | "ide.docs.detected"
  | "ide.architecture.detected"
  | "ide.diagnostics.reported"
  | "ide.git.context"
  | "ide.git.history"
  | "ide.code.structure"
  | "ide.project.summary";

export const IDE_EPISODE_KINDS: ReadonlyArray<IdeEpisodeKind> = [
  "ide.workspace.indexed",
  "ide.file.changed",
  "ide.docs.detected",
  "ide.architecture.detected",
  "ide.diagnostics.reported",
  "ide.git.context",
  "ide.git.history",
  "ide.code.structure",
  "ide.project.summary",
];

/** How the default subject is derived. `auto` = repo-if-git-remote else workspace. */
export type SubjectStrategy = "auto" | "repo" | "workspace" | "custom";

/**
 * The companion configuration. The VS Code extension builds this from
 * `statewave.*` settings; tests construct it directly. No field is read from
 * disk or the network implicitly.
 */
export interface IdeCompanionConfig {
  /** Statewave instance base URL (e.g. http://localhost:8000). */
  url?: string;
  /** Statewave API key. Never logged. */
  apiKey?: string;
  /** Subject derivation strategy. */
  subjectStrategy: SubjectStrategy;
  /** Explicit subject when `subjectStrategy === "custom"`. */
  customSubject?: string;
  /**
   * When false (the default) the companion never ingests on its own — the
   * file watcher still observes, but nothing is sent until the user runs a
   * command explicitly, and even then the first run previews.
   */
  autoIndex: boolean;
  /** Extra globs to include (added to the always-on key files). */
  includeGlobs: ReadonlyArray<string>;
  /** Globs to exclude (added to the built-in ignore set). */
  excludeGlobs: ReadonlyArray<string>;
  /** When true, apply email/phone/secret redaction to every episode's text. */
  redactionEnabled: boolean;
  /**
   * When true (default), compile the subject into durable memory right after
   * a successful ingest. Off ⇒ episodes are stored but memories are not
   * (re)built until something else compiles the subject.
   */
  compileAfterIngest: boolean;
  /**
   * When true (default), the plugin auto-wires the Statewave MCP server into
   * the editor (VS Code provider + Cursor global config) so the assistant can
   * read project memory with no manual MCP setup. Off ⇒ wire it yourself.
   */
  mcpAutoWire: boolean;
  /**
   * Allowlist of assistant clients to auto-wire (subset of
   * copilot/cursor/windsurf/claude/cline/roo/continue). Each is still only
   * touched when that client is actually installed.
   */
  mcpClients: ReadonlyArray<string>;
  /**
   * Reflexive agent instructions written into the repo (no secrets):
   * `read-write` (consult the brain + persist durable user facts),
   * `read-only` (consult only), or `off` (write nothing).
   */
  assistantInstructions: "read-write" | "read-only" | "off";
}

/** A single classified file discovered while scanning the workspace. */
export interface ScannedWorkspaceFile {
  /** Path relative to the workspace root, POSIX separators. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Short sha256 of the file content (16 hex chars). */
  hash: string;
  /** Byte size. */
  size: number;
  /** ISO 8601 mtime. */
  mtime: string;
  /** Coarse classification used for summary + episode routing. */
  category: FileCategory;
}

/**
 * Coarse, retrieval-oriented file classes. Deliberately small — this drives
 * the project summary and which files become which episode kind, not a
 * full language taxonomy.
 */
export type FileCategory =
  | "readme"
  | "node-manifest"
  | "workspace-manifest"
  | "tsconfig"
  | "python-manifest"
  | "dockerfile"
  | "compose"
  | "doc"
  | "adr"
  | "rfc"
  | "decision"
  | "test"
  | "config"
  | "source"
  | "other";

/** Parsed git state, read from `.git/` without spawning git. */
export interface GitContext {
  /** Current branch name, or null when detached / unreadable. */
  branch: string | null;
  /** First remote URL found (origin preferred), or null. */
  remoteUrl: string | null;
  /** Parsed owner when the remote is a recognised host, else null. */
  owner: string | null;
  /** Parsed repo name when the remote is a recognised host, else null. */
  repo: string | null;
  /** Host slug (`github.com`, `gitlab.com`, …) when parseable, else null. */
  host: string | null;
}

/** The result of scanning a workspace folder. */
export interface WorkspaceScan {
  /** Absolute workspace root. */
  root: string;
  /** Folder basename — used for the `workspace:` subject fallback. */
  folderName: string;
  /** Every classified, non-ignored file. */
  files: ReadonlyArray<ScannedWorkspaceFile>;
  /** Total files visited (including ignored), for transparency. */
  filesVisited: number;
  /** Files dropped by the ignore set / exclude globs. */
  filesIgnored: number;
}

/** The compact, durable project model derived from a scan + git context. */
export interface ProjectSummary {
  name: string;
  subject: string;
  branch: string | null;
  remoteUrl: string | null;
  /** Detected package managers / build tools (pnpm, npm, poetry, docker, …). */
  toolchain: ReadonlyArray<string>;
  /** Detected languages, best-effort from manifests + extensions. */
  languages: ReadonlyArray<string>;
  /** Top-level directories, sorted, capped. */
  layout: ReadonlyArray<string>;
  /** Key documentation files (README, docs/**, ADR/RFC/decision). */
  keyDocs: ReadonlyArray<string>;
  /** Architecture/decision docs specifically (ADR/RFC/decision). */
  architectureDocs: ReadonlyArray<string>;
  /** Free-form convention hints inferred from the tree (monorepo, strict TS, …). */
  conventions: ReadonlyArray<string>;
  hasTests: boolean;
  fileCount: number;
}

/** A change observed by the file watcher (debounced + classified upstream). */
export interface ChangedFile {
  relativePath: string;
  absolutePath: string;
  /** "saved" | "created" | "deleted" — deletions carry no hash. */
  changeType: "saved" | "created" | "deleted";
  hash?: string;
  category?: FileCategory;
  occurredAt?: string;
}

/** A diagnostic, normalised away from the editor's own shape. */
export interface DiagnosticRecord {
  relativePath: string;
  severity: "error" | "warning" | "info" | "hint";
  /** Diagnostic code as a string, when the editor provides one. */
  code?: string;
  message: string;
  source?: string;
  line?: number;
}

/** Outcome of an ingest attempt (or a dry-run preview). */
export interface IngestOutcome {
  dryRun: boolean;
  attempted: number;
  ingested: number;
  failed: number;
  /** Per-kind histogram, stable shape for the extension's summary UI. */
  kinds: Record<string, number>;
  /** First error message, when any episode failed (dry-run never fails). */
  errorSample?: string;
}
