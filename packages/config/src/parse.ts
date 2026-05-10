// TOML → typed config, end to end.
//
// loadConfig() is the one-call API the CLI and the runner use.
// Steps:
//   1. Resolve where to load from (explicit / env / cwd / xdg).
//   2. Read the file and parse it as TOML.
//   3. Walk every string and interpolate `${VAR}` / `${VAR:-fallback}`.
//   4. Validate the shape and produce a typed StatewaveConnectorsConfig.
//   5. Surface any of (4 — issues), (3 — missing env), (2 — parse error),
//      or (1 — not_found) as a single ConfigError with a tailored code.

import { readFile } from "node:fs/promises";
import os from "node:os";
import { parse as parseToml } from "smol-toml";
import { ConfigError, type ValidationIssue } from "./errors.js";
import { interpolate } from "./env-interpolate.js";
import {
  resolveConfigPath,
  type ConfigSource,
  type ResolveOptions,
} from "./search-paths.js";
import type { StatewaveConnectorsConfig } from "./schema.js";
import { validate } from "./validate.js";

export interface LoadConfigOptions extends ResolveOptions {
  /** Inject a parsed-TOML payload directly, bypassing file I/O.
   * Mostly useful for tests; the CLI never sets this. */
  rawTomlString?: string;
}

export interface LoadedConfig {
  /** Absolute path the config was read from (null when `rawTomlString` is used). */
  path: string | null;
  /** Which slot in the search order won. */
  source: ConfigSource;
  config: StatewaveConnectorsConfig;
}

/**
 * Resolve, parse, interpolate, and validate the config in one shot. On
 * any failure raises a `ConfigError` with a typed `code` so the caller
 * can render an appropriate message:
 *
 *   - `not_found`         — no candidate path existed (and no rawTomlString)
 *   - `parse_error`       — TOML syntax error (cause carries smol-toml's error)
 *   - `missing_env`       — one or more `${VAR}` references unresolved
 *   - `validation_error`  — schema problem(s); `issues` lists every one
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const env = options.env ?? process.env;

  let tomlString: string;
  let path: string | null = null;
  let source: ConfigSource = "explicit";

  if (options.rawTomlString !== undefined) {
    tomlString = options.rawTomlString;
    path = null;
    source = "explicit";
  } else {
    const homeDir = options.homeDir ?? os.homedir();
    const resolved = resolveConfigPath({ ...options, env, homeDir });
    if (resolved.path === null) {
      throw new ConfigError(
        "not_found",
        "no statewave-connectors config file found",
        {
          searched: resolved.searched,
        },
      );
    }
    path = resolved.path;
    source = resolved.source;
    try {
      tomlString = await readFile(path, "utf8");
    } catch (err) {
      throw new ConfigError("not_found", `failed to read config at ${path}`, {
        cause: err,
      });
    }
  }

  let parsed: unknown;
  try {
    parsed = parseToml(tomlString);
  } catch (err) {
    throw new ConfigError(
      "parse_error",
      `TOML parse error in ${path ?? "(injected string)"}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const { missing } = interpolate(parsed, env);
  if (missing.length > 0) {
    throw new ConfigError(
      "missing_env",
      `${missing.length} required env var(s) missing: ${missing.join(", ")}`,
      { missing },
    );
  }

  const result = validate(parsed);
  if (result.issues.length > 0 || !result.config) {
    throw new ConfigError(
      "validation_error",
      `${result.issues.length} validation issue(s) in config`,
      { issues: result.issues as ValidationIssue[] },
    );
  }

  return { path, source, config: result.config };
}
