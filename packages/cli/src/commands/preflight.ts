import { execFileSync } from "node:child_process";

/**
 * Dependency / environment preflight.
 *
 * Distinguishes the failure modes that matter — Docker CLI missing vs daemon
 * stopped vs Compose v2 missing vs permission denied — because each needs
 * different, OS-specific guidance. The classification helpers are pure so they
 * can be unit-tested without a real Docker install.
 *
 * Node and npm/npx are necessarily already present (this code runs under them),
 * so we only version-check Node; Git and Docker are the real gates.
 */

export const MIN_NODE_MAJOR = 20;

export type DockerState = "ok" | "no-cli" | "no-compose" | "daemon-down" | "denied";

/** Major version from a `process.version`-style string ("v20.11.1" → 20). */
export function parseNodeMajor(version: string): number {
  const m = version.match(/v?(\d+)\./);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}

export function nodeMeetsMinimum(version: string, min = MIN_NODE_MAJOR): boolean {
  return parseNodeMajor(version) >= min;
}

/** Classify a `docker info` failure from its stderr. Pure. */
export function classifyDockerError(stderr: string): Exclude<DockerState, "ok" | "no-cli" | "no-compose"> {
  const s = stderr.toLowerCase();
  if (s.includes("permission denied")) return "denied";
  // "Cannot connect to the Docker daemon", "Is the docker daemon running?",
  // "error during connect", "the docker daemon is not running" (Windows).
  return "daemon-down";
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; code?: string };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout) : "",
      stderr: e.stderr ? String(e.stderr) : (err as Error).message,
    };
  }
}

/** Whether `git` is on the PATH. */
export function gitAvailable(): boolean {
  return run("git", ["--version"]).ok;
}

/**
 * Resolve Docker into one concrete state. Order matters: a missing CLI shadows
 * everything; then Compose v2; then the daemon (info), which also reveals
 * permission problems.
 */
export function dockerState(): DockerState {
  if (!run("docker", ["--version"]).ok) return "no-cli";
  if (!run("docker", ["compose", "version"]).ok) return "no-compose";
  const info = run("docker", ["info"]);
  if (info.ok) return "ok";
  return classifyDockerError(info.stderr);
}

export type DockerInstallMethod = "brew" | "winget" | "get-docker-sh" | "none";

/** Best available auto-install method for Docker on this machine.
 *  Returns "none" when there is no known unattended path. */
export function dockerInstallMethod(platform: NodeJS.Platform = process.platform): DockerInstallMethod {
  if (platform === "darwin") return run("brew", ["--version"]).ok ? "brew" : "none";
  if (platform === "win32") return run("winget", ["--version"]).ok ? "winget" : "none";
  // Linux: official get.docker.com installer (needs curl or wget)
  if (run("curl", ["--version"]).ok || run("wget", ["--version"]).ok) return "get-docker-sh";
  return "none";
}

/** OS-specific, actionable guidance for a Docker problem. */
export function dockerFixHint(state: DockerState, platform: NodeJS.Platform = process.platform): string[] {
  const mac = platform === "darwin";
  const win = platform === "win32";
  switch (state) {
    case "no-cli":
      if (mac) return ["Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/", "Or: brew install --cask docker"];
      if (win) return ["Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/"];
      return ["Install Docker Engine: https://docs.docker.com/engine/install/", "Then the Compose plugin: https://docs.docker.com/compose/install/linux/"];
    case "no-compose":
      return [
        "Docker is installed but Compose v2 (`docker compose`) is missing.",
        mac || win ? "Update Docker Desktop to a recent version." : "Install the Compose plugin: https://docs.docker.com/compose/install/linux/",
      ];
    case "daemon-down":
      if (mac) return ["Docker is installed but the daemon isn't running.", "Start it: open -a Docker  (or launch Docker Desktop), then retry."];
      if (win) return ["Docker is installed but the daemon isn't running.", "Start Docker Desktop, wait for it to report Running, then retry."];
      return ["Docker is installed but the daemon isn't running.", "Start it: sudo systemctl start docker  (then retry)."];
    case "denied":
      if (!mac && !win) return ["Permission denied talking to the Docker daemon.", "Add yourself to the docker group: sudo usermod -aG docker $USER  (then log out/in), or run with sudo."];
      return ["Permission denied talking to the Docker daemon.", "Ensure Docker Desktop is running and you have access, then retry."];
    case "ok":
      return [];
  }
}
