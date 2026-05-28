import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Declared project run-commands collected for the `ide.project.commands`
 * memory signal — answers the assistant's "what commands do I run?".
 *
 * Scope is deliberately narrow and privacy-safe: only **declared** command
 * names/scripts from a project's manifests. We never read source-file bodies,
 * lockfiles, environment files, or chat — just the command surface a developer
 * would type.
 */
export interface ProjectCommand {
  /** Which manifest the command was declared in. */
  source: "package.json" | "Makefile" | "pyproject.toml";
  /** Command / target name (e.g. `build`, `test`). */
  name: string;
  /** The command a developer would run (e.g. `vitest run`, `make build`). */
  command: string;
}

export interface ProjectManifests {
  packageJson?: string | null;
  makefile?: string | null;
  pyproject?: string | null;
}

/**
 * Parse declared commands from manifest *contents*. Pure — no disk access, no
 * network. Collects only: `package.json` `scripts`, `Makefile` targets, and the
 * `[project.scripts]` / `[tool.poetry.scripts]` tables of `pyproject.toml`.
 */
export function parseProjectCommands(m: ProjectManifests): ProjectCommand[] {
  const out: ProjectCommand[] = [];
  if (m.packageJson) out.push(...parsePackageJsonScripts(m.packageJson));
  if (m.makefile) out.push(...parseMakefileTargets(m.makefile));
  if (m.pyproject) out.push(...parsePyprojectScripts(m.pyproject));
  return out;
}

function parsePackageJsonScripts(content: string): ProjectCommand[] {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return [];
  }
  const scripts = (obj as { scripts?: Record<string, unknown> } | null)?.scripts;
  if (!scripts || typeof scripts !== "object") return [];
  const out: ProjectCommand[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (typeof cmd === "string") out.push({ source: "package.json", name, command: cmd });
  }
  return out;
}

// First-column target before a single `:` (not the `:=` assignment form).
const MAKE_TARGET = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/;

function parseMakefileTargets(content: string): ProjectCommand[] {
  const seen = new Set<string>();
  const out: ProjectCommand[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = MAKE_TARGET.exec(line);
    if (!m) continue;
    const name = m[1]!;
    if (name.startsWith(".")) continue; // .PHONY, .DEFAULT, etc.
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ source: "Makefile", name, command: `make ${name}` });
  }
  return out;
}

// Dependency-free extraction of just the two script tables — we do NOT pull in
// a TOML parser. Read line-by-line, only inside `[project.scripts]` /
// `[tool.poetry.scripts]`, until the next table header.
const SCRIPT_TABLES = new Set(["[project.scripts]", "[tool.poetry.scripts]"]);
const TOML_ENTRY = /^([A-Za-z0-9_.-]+)\s*=\s*["'](.+?)["']\s*$/;

function parsePyprojectScripts(content: string): ProjectCommand[] {
  const out: ProjectCommand[] = [];
  let inTable = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inTable = SCRIPT_TABLES.has(line);
      continue;
    }
    if (!inTable || !line || line.startsWith("#")) continue;
    const m = TOML_ENTRY.exec(line);
    if (m) out.push({ source: "pyproject.toml", name: m[1]!, command: m[2]! });
  }
  return out;
}

/**
 * Read the three known manifests from `rootDir` (when present) and parse the
 * declared commands. Missing files are skipped silently. Reads only these
 * three files — never globs, never reads source bodies or lockfiles.
 */
export async function collectProjectCommands(rootDir: string): Promise<ProjectCommand[]> {
  const read = async (name: string): Promise<string | null> => {
    try {
      return await fs.readFile(path.join(rootDir, name), "utf8");
    } catch {
      return null;
    }
  };
  const [packageJson, makefile, pyproject] = await Promise.all([
    read("package.json"),
    read("Makefile"),
    read("pyproject.toml"),
  ]);
  return parseProjectCommands({ packageJson, makefile, pyproject });
}
