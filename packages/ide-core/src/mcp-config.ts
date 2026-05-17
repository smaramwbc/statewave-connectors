/**
 * Pure helpers for the "the plugin owns the MCP wiring" model.
 *
 * The product goal: the developer configures Statewave **once** (in the
 * plugin), and Copilot/Cursor can read the project's memory with no second
 * config file to hand-edit and no extra container to run. The Statewave
 * memory runtime becomes the always-present project brain so the assistant
 * makes fewer mistakes.
 *
 * Nothing here imports `vscode` or touches disk — the editor host does the
 * I/O and calls these to compute *what* to register/write. That keeps the
 * merge logic (the part that can silently corrupt a user's MCP file) fully
 * unit-tested.
 */

/** The single server key the plugin manages. We never touch other servers. */
export const STATEWAVE_MCP_KEY = "statewave";
export const STATEWAVE_MCP_LABEL = "Statewave Project Memory";

export interface McpStdioEntry {
  command: string;
  args: ReadonlyArray<string>;
  env: Record<string, string>;
}

/**
 * Build the stdio launch entry for the bundled MCP server.
 *
 * The API key rides in `env` (process environment of the spawned server),
 * never in argv. When no key is configured we omit it rather than write an
 * empty one.
 */
export function buildStdioEntry(input: {
  command: string;
  serverScriptPath: string;
  url: string;
  apiKey?: string;
  tenantId?: string;
}): McpStdioEntry {
  const env: Record<string, string> = { STATEWAVE_URL: input.url };
  if (input.apiKey) env.STATEWAVE_API_KEY = input.apiKey;
  if (input.tenantId) env.STATEWAVE_TENANT_ID = input.tenantId;
  return {
    command: input.command,
    args: [input.serverScriptPath],
    env,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shallowJsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface MergeResult {
  config: Record<string, unknown>;
  changed: boolean;
}

/**
 * Merge our managed server into a Cursor `mcp.json`
 * (`{ "mcpServers": { "<name>": { command, args, env } } }`), preserving
 * every other server untouched.
 *
 * `changed` is false when our entry is already byte-identical — the caller
 * skips the write so we never churn the user's file or its mtime.
 */
export function mergeCursorConfig(
  existing: unknown,
  entry: McpStdioEntry,
): MergeResult {
  const root: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  const servers: Record<string, unknown> = isRecord(root["mcpServers"])
    ? { ...(root["mcpServers"] as Record<string, unknown>) }
    : {};
  const next = { command: entry.command, args: [...entry.args], env: entry.env };
  const changed = !shallowJsonEqual(servers[STATEWAVE_MCP_KEY], next);
  servers[STATEWAVE_MCP_KEY] = next;
  root["mcpServers"] = servers;
  return { config: root, changed };
}

/**
 * Merge our managed server into a VS Code `.vscode/mcp.json`
 * (`{ "servers": { "<name>": { type: "stdio", command, args, env } } }`).
 * Only used as a fallback when the VS Code MCP provider API is unavailable
 * (older VS Code); the primary VS Code path registers in-memory and writes
 * nothing.
 */
export function mergeVscodeMcpConfig(
  existing: unknown,
  entry: McpStdioEntry,
): MergeResult {
  const root: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  const servers: Record<string, unknown> = isRecord(root["servers"])
    ? { ...(root["servers"] as Record<string, unknown>) }
    : {};
  const next = {
    type: "stdio",
    command: entry.command,
    args: [...entry.args],
    env: entry.env,
  };
  const changed = !shallowJsonEqual(servers[STATEWAVE_MCP_KEY], next);
  servers[STATEWAVE_MCP_KEY] = next;
  root["servers"] = servers;
  return { config: root, changed };
}

/**
 * Merge our managed server into Claude Code's **local scope** inside
 * `~/.claude.json`: `projects["<absolute-project-path>"].mcpServers.statewave`.
 *
 * Local scope is the right target: `~/.claude.json` lives in the home dir
 * (never committed → no key in VCS), it has no approval gate (unlike a
 * project `.mcp.json`), and Claude Code auto-loads it on the next session.
 *
 * `~/.claude.json` is Claude Code's primary config file, so this merge is
 * deliberately surgical — every other key, every other project, and every
 * other server is preserved byte-for-byte. The caller must never write this
 * if the file failed to parse.
 */
export function mergeClaudeProjectConfig(
  existing: unknown,
  projectPath: string,
  entry: McpStdioEntry,
): MergeResult {
  const root: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  const projects: Record<string, unknown> = isRecord(root["projects"])
    ? { ...(root["projects"] as Record<string, unknown>) }
    : {};
  const project: Record<string, unknown> = isRecord(projects[projectPath])
    ? { ...(projects[projectPath] as Record<string, unknown>) }
    : {};
  const servers: Record<string, unknown> = isRecord(project["mcpServers"])
    ? { ...(project["mcpServers"] as Record<string, unknown>) }
    : {};
  const next = {
    type: "stdio",
    command: entry.command,
    args: [...entry.args],
    env: entry.env,
  };
  const changed = !shallowJsonEqual(servers[STATEWAVE_MCP_KEY], next);
  servers[STATEWAVE_MCP_KEY] = next;
  project["mcpServers"] = servers;
  projects[projectPath] = project;
  root["projects"] = projects;
  return { config: root, changed };
}
