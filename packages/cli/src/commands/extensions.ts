import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";

/**
 * IDE Companion installation — cross-platform and verified.
 *
 * The hard parts: (1) VS Code forks (Cursor) install a `code` shim that
 * launches the fork, so we resolve each editor's own app-bundle CLI first;
 * (2) a 0-exit from `--install-extension` does not prove the extension is
 * present, so installation is always re-verified by listing extensions. The
 * resolver, lister, and installer are injectable so the full matrix is unit
 * tested without a real editor.
 */

export const EXTENSION_ID = "statewavedev.statewave-ide-companion";

interface EditorSpec {
  command: string;
  /** Per-platform bundled-CLI candidate paths (checked before the PATH command). */
  bundles: Partial<Record<NodeJS.Platform, string[]>>;
}

const EDITORS: Record<string, EditorSpec> = {
  vscode: {
    command: "code",
    bundles: {
      darwin: [
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        "~/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      ],
      win32: [
        "%LOCALAPPDATA%/Programs/Microsoft VS Code/bin/code.cmd",
        "%PROGRAMFILES%/Microsoft VS Code/bin/code.cmd",
      ],
      linux: ["/usr/share/code/bin/code", "/usr/bin/code", "/snap/bin/code", "/opt/visual-studio-code/bin/code"],
    },
  },
  cursor: {
    command: "cursor",
    bundles: {
      darwin: [
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        "/Applications/Cursor.app/Contents/Resources/app/bin/code",
        "~/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      ],
      win32: [
        "%LOCALAPPDATA%/Programs/cursor/resources/app/bin/cursor.cmd",
        "%LOCALAPPDATA%/Programs/Cursor/resources/app/bin/cursor.cmd",
      ],
      linux: ["/usr/share/cursor/bin/cursor", "/usr/bin/cursor", "/opt/Cursor/bin/cursor"],
    },
  },
};

export function isEditorClient(id: string): boolean {
  return id in EDITORS;
}

function expandPath(p: string): string {
  let out = p;
  if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  out = out.replace("%LOCALAPPDATA%", process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"));
  out = out.replace("%PROGRAMFILES%", process.env.PROGRAMFILES ?? "C:/Program Files");
  // normalize unifies mixed separators (e.g. LOCALAPPDATA backslashes + /template/
  // forward-slashes) into the platform's native separator so spawnSync doesn't
  // receive an EINVAL path on Windows.
  return normalize(out);
}

export interface ResolveOpts {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  pathDirs?: string[];
}

/** Resolve an editor's CLI to a concrete binary, app-bundle first then PATH. */
export function resolveEditorCli(clientId: string, opts: ResolveOpts = {}): string | undefined {
  const spec = EDITORS[clientId];
  if (!spec) return undefined;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  for (const raw of spec.bundles[platform] ?? []) {
    const p = expandPath(raw);
    if (exists(p)) return p;
  }
  const sep = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? [`${spec.command}.cmd`, `${spec.command}.exe`, spec.command] : [spec.command];
  const dirs = opts.pathDirs ?? (process.env.PATH ?? "").split(sep);
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) {
      const p = join(d, n);
      if (exists(p)) return p;
    }
  }
  return undefined;
}

/** Best-effort editor identity from a resolved CLI path (Cursor, VSCodium, …). */
export function editorIdentity(realPath: string): string {
  const p = realPath.toLowerCase();
  if (p.includes("cursor")) return "Cursor";
  if (p.includes("vscodium")) return "VSCodium";
  if (p.includes("windsurf")) return "Windsurf";
  if (p.includes("code")) return "VS Code";
  return realPath;
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export type CommandRunner = (cli: string, args: string[]) => { ok: boolean; stdout: string; stderr: string };

const realRunner: CommandRunner = (cli, args) => {
  try {
    // Node 20.12.2+ (CVE-2024-27980 security patch) blocks direct execFileSync of
    // .cmd/.bat files — they must go through cmd.exe /d /c.
    const isWindowsScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(cli);
    const [execCli, execArgs]: [string, string[]] = isWindowsScript
      ? ["cmd.exe", ["/d", "/c", cli, ...args]]
      : [cli, args];
    const stdout = execFileSync(execCli, execArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return { ok: false, stdout: e.stdout ? String(e.stdout) : "", stderr: e.stderr ? String(e.stderr) : (err as Error).message };
  }
};

export function listInstalledExtensions(cli: string, runner: CommandRunner = realRunner): Set<string> {
  const r = runner(cli, ["--list-extensions"]);
  if (!r.ok) return new Set();
  return new Set(r.stdout.split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export type InstallStatus = "installed" | "updated" | "already" | "no-cli" | "failed" | "unverified";
export interface InstallResult {
  status: InstallStatus;
  /** Editor we actually resolved to (e.g. "Cursor" when `code` is a fork shim). */
  via?: string;
  /** Absolute resolved binary, for dedup across clients sharing a CLI. */
  binary?: string;
  message?: string;
}

export interface InstallDeps {
  vsixGiven?: boolean;
  resolve?: (id: string) => string | undefined;
  list?: (cli: string) => Set<string>;
  install?: (cli: string, target: string) => { ok: boolean; message: string };
  realpath?: (p: string) => string;
}

/**
 * Resolve → (already installed?) → install → VERIFY by re-listing. Returns a
 * status that the caller turns into honest output. Never reports success
 * without the post-install verification.
 */
export function installAndVerify(clientId: string, target: string, deps: InstallDeps = {}): InstallResult {
  const resolve = deps.resolve ?? ((id: string) => resolveEditorCli(id));
  const list = deps.list ?? ((cli: string) => listInstalledExtensions(cli));
  const install =
    deps.install ??
    ((cli: string, t: string) => {
      const r = realRunner(cli, ["--install-extension", t, "--force"]);
      return { ok: r.ok, message: lastLine(r.ok ? r.stdout : r.stderr || "install failed") || (r.ok ? "installed" : "install failed") };
    });
  const realpath = deps.realpath ?? ((p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });

  const binPath = resolve(clientId);
  if (!binPath) return { status: "no-cli" };
  const binary = realpath(binPath);
  const via = editorIdentity(binary);
  const id = EXTENSION_ID.toLowerCase();

  const alreadyInstalled = list(binPath).has(id);
  if (alreadyInstalled && !deps.vsixGiven) return { status: "already", via, binary };

  const r = install(binPath, target);
  if (!r.ok) return { status: "failed", via, binary, message: r.message };

  // A 0-exit isn't proof — re-list to verify the extension is actually present.
  if (list(binPath).has(id)) return { status: alreadyInstalled ? "updated" : "installed", via, binary };
  return { status: "unverified", via, binary, message: r.message };
}
