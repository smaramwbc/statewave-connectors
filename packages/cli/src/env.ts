export interface StatewaveEnv {
  url?: string;
  apiKey?: string;
  tenantId?: string;
}

export function readStatewaveEnv(env: NodeJS.ProcessEnv = process.env): StatewaveEnv {
  return {
    url: env.STATEWAVE_URL,
    apiKey: env.STATEWAVE_API_KEY,
    tenantId: env.STATEWAVE_TENANT_ID,
  };
}

/**
 * OS- and shell-aware guidance for setting environment variables, so users
 * don't have to guess the syntax. Uses STATEWAVE_URL as the worked example; the
 * same pattern applies to every variable the CLI reads.
 */
export function envSetupHint(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return [
      "setting environment variables (Windows):",
      '  PowerShell, this session:  $env:STATEWAVE_URL = "http://localhost:8100"',
      '  PowerShell, persist:       setx STATEWAVE_URL "http://localhost:8100"',
      "  Command Prompt, session:   set STATEWAVE_URL=http://localhost:8100",
      "  (repeat for STATEWAVE_API_KEY and any connector tokens listed above)",
    ].join("\n");
  }
  const shell = env.SHELL ?? "";
  const profile = shell.includes("zsh") ? "~/.zshrc" : shell.includes("bash") ? "~/.bashrc" : "~/.profile";
  return [
    "setting environment variables (macOS / Linux):",
    '  this shell:  export STATEWAVE_URL="http://localhost:8100"',
    `  persist:     echo 'export STATEWAVE_URL="http://localhost:8100"' >> ${profile}  (then restart the shell)`,
    "  (repeat for STATEWAVE_API_KEY and any connector tokens listed above)",
  ].join("\n");
}
