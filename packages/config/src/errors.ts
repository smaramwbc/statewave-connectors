// Typed error hierarchy for the config loader.
//
// Every failure mode the loader can raise carries a stable `code` so
// callers (the CLI, the runner) can render a tailored message instead
// of dumping a generic stack. Validation errors carry a list of
// per-issue diagnostics — the goal is "report every problem in one
// pass" so an operator sees the full punch list and fixes everything
// at once instead of edit-run-edit-run.

export type ConfigErrorCode =
  | "not_found"
  | "parse_error"
  | "validation_error"
  | "missing_env";

export interface ValidationIssue {
  /** Dotted path into the config (e.g. `pull.github[0].repo`). */
  path: string;
  /** Human-readable message. */
  message: string;
}

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly issues: ReadonlyArray<ValidationIssue>;
  /** Searched paths (only set on `not_found`). */
  readonly searched: ReadonlyArray<{ source: string; path: string }>;
  /** Missing env-var names (only set on `missing_env`). */
  readonly missing: ReadonlyArray<string>;

  constructor(
    code: ConfigErrorCode,
    message: string,
    extra: {
      issues?: ReadonlyArray<ValidationIssue>;
      searched?: ReadonlyArray<{ source: string; path: string }>;
      missing?: ReadonlyArray<string>;
      cause?: unknown;
    } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "ConfigError";
    this.code = code;
    this.issues = extra.issues ?? [];
    this.searched = extra.searched ?? [];
    this.missing = extra.missing ?? [];
  }
}
