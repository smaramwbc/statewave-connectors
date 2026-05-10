// Config-file search order, in priority. First match wins.
//
//   1. Explicit --config <path> (caller passes it to loadConfig)
//   2. $STATEWAVE_CONNECTORS_CONFIG environment variable
//   3. ./statewave-connectors.toml in cwd
//   4. $XDG_CONFIG_HOME/statewave-connectors/config.toml
//      ($XDG_CONFIG_HOME defaults to ~/.config when unset)
//
// Loader returns the first existing path along with which slot it came
// from, so doctor / validate-config can report it.

import { existsSync } from "node:fs";
import path from "node:path";

export type ConfigSource =
  | "explicit"
  | "env"
  | "cwd"
  | "xdg"
  | "not_found";

export interface ResolveOptions {
  /** Explicit override (highest priority). */
  configPath?: string;
  /** Working directory for the cwd-relative lookup. Defaults to process.cwd(). */
  cwd?: string;
  /** Home dir for the XDG fallback. Defaults to os.homedir(). */
  homeDir?: string;
  /** Env-var bag for testability. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Inject existsSync for tests. Defaults to fs.existsSync. */
  exists?: (path: string) => boolean;
}

export interface ResolveResult {
  source: ConfigSource;
  path: string | null;
  /**
   * The full ordered list of paths that were consulted, useful for
   * diagnostic output ("we looked in X, Y, Z and found nothing").
   */
  searched: ReadonlyArray<{ source: ConfigSource; path: string }>;
}

export function resolveConfigPath(options: ResolveOptions = {}): ResolveResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? "";
  const exists = options.exists ?? existsSync;

  const candidates: Array<{ source: ConfigSource; path: string | null }> = [];

  if (options.configPath) {
    candidates.push({ source: "explicit", path: options.configPath });
  }

  const fromEnv = env.STATEWAVE_CONNECTORS_CONFIG;
  if (fromEnv) candidates.push({ source: "env", path: fromEnv });

  candidates.push({
    source: "cwd",
    path: path.join(cwd, "statewave-connectors.toml"),
  });

  if (homeDir) {
    const xdgRoot = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
    candidates.push({
      source: "xdg",
      path: path.join(xdgRoot, "statewave-connectors", "config.toml"),
    });
  }

  const searched = candidates
    .filter((c): c is { source: ConfigSource; path: string } => c.path !== null)
    .map((c) => ({ source: c.source, path: c.path }));

  for (const candidate of searched) {
    if (exists(candidate.path)) {
      return { source: candidate.source, path: candidate.path, searched };
    }
  }

  return { source: "not_found", path: null, searched };
}
