// Registry of MCP clients that `statewave-connectors mcp init` can configure.
//
// The MCP server is vendor-neutral (see packages/mcp-server), so the only
// per-client variation is *where* the config lives and *what shape* the entry
// takes. Each client here pins three things we cannot guess at runtime:
//
//   - the config file the client reads MCP servers from (and whether it is
//     project-scoped or user-scoped)
//   - the JSON container key (`mcpServers` vs VS Code's `servers`) or the TOML
//     table prefix (`mcp_servers` for Codex)
//   - the instruction file the assistant reads, so `init` can drop in the
//     "call statewave_get_context first" guidance that actually makes the
//     tools get used
//
// Config-file shapes are defined by each client and do shift over time; we keep
// the generated entry minimal and standard so it stays valid as they evolve.
// Adding a client is a single entry in CLIENTS — no other code changes.

/** npm package that ships the stdio MCP server bin (`statewave-mcp-server`). */
export const MCP_SERVER_PACKAGE = "@statewavedev/mcp-server";

/** Default Statewave server URL used when the caller passes no --statewave-url. */
export const DEFAULT_STATEWAVE_URL = "http://localhost:8100";

/** Default MCP server id written into the client config. */
export const DEFAULT_SERVER_NAME = "statewave";

export type ConfigFormat = "json" | "toml";
export type ConfigScope = "project" | "user";

export interface ClientDef {
  /** Stable id used on the command line (e.g. `mcp init claude`). */
  id: string;
  /** Human label for help/output. */
  label: string;
  /** Whether the config file is per-project (cwd) or per-user (home dir). */
  scope: ConfigScope;
  /**
   * Config path. Project-scoped paths are relative to the working directory;
   * user-scoped paths begin with `~/` and are resolved against the home dir.
   */
  configPath: string;
  /**
   * OS-specific config paths for user-scoped clients whose location differs by
   * platform (e.g. Claude Desktop). `~` resolves to the home dir and `%APPDATA%`
   * to the env var. When present, it overrides `configPath` for the I/O path.
   */
  platformPaths?: Partial<Record<NodeJS.Platform, string>>;
  format: ConfigFormat;
  /** JSON container key for the server map. Omitted for TOML clients. */
  containerKey?: string;
  /**
   * Some clients (VS Code) require an explicit `"type": "stdio"` on the entry.
   * Left undefined when the client infers transport from `command`.
   */
  jsonEntryType?: string;
  /**
   * Project-relative instruction file the assistant reads. Omitted for chat
   * apps (Claude Desktop) that have no per-repo instruction file — there the
   * guidance is printed for the user to paste into their custom instructions.
   */
  instructionFile?: string;
  /** One-line note shown after configuring (e.g. "restart to pick up servers"). */
  note: string;
}

// Ordered by how commonly they're used as Statewave MCP hosts. The four below
// have stable, documented config locations; others (Windsurf, Cline) can be
// added the same way once their paths are pinned.
export const CLIENTS: ReadonlyArray<ClientDef> = [
  {
    id: "claude",
    label: "Claude Code",
    scope: "project",
    configPath: ".mcp.json",
    format: "json",
    containerKey: "mcpServers",
    instructionFile: "CLAUDE.md",
    note: "Project .mcp.json is shared with the repo; restart Claude Code to load the server.",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    scope: "user",
    configPath: "~/Library/Application Support/Claude/claude_desktop_config.json",
    platformPaths: {
      darwin: "~/Library/Application Support/Claude/claude_desktop_config.json",
      win32: "%APPDATA%/Claude/claude_desktop_config.json",
      linux: "~/.config/Claude/claude_desktop_config.json",
    },
    format: "json",
    containerKey: "mcpServers",
    // Chat app, not repo-scoped — no instruction file; the guidance is printed
    // for the user to paste into Claude's personalization / project instructions.
    note: "Claude Desktop is a local stdio client; quit and reopen it to load the server.",
  },
  {
    id: "cursor",
    label: "Cursor",
    scope: "project",
    configPath: ".cursor/mcp.json",
    format: "json",
    containerKey: "mcpServers",
    instructionFile: "AGENTS.md",
    note: "Cursor reads .cursor/mcp.json per project; toggle the server on in Settings → MCP.",
  },
  {
    id: "vscode",
    label: "VS Code (GitHub Copilot)",
    scope: "project",
    configPath: ".vscode/mcp.json",
    format: "json",
    containerKey: "servers",
    jsonEntryType: "stdio",
    instructionFile: ".github/copilot-instructions.md",
    note: "VS Code uses `servers` (not `mcpServers`) and needs `type: stdio`; reload the window.",
  },
  {
    id: "codex",
    label: "Codex CLI",
    scope: "user",
    configPath: "~/.codex/config.toml",
    format: "toml",
    instructionFile: "AGENTS.md",
    note: "Codex config is user-scoped (~/.codex/config.toml); the AGENTS.md guidance stays per-project.",
  },
];

export function findClient(id: string): ClientDef | undefined {
  return CLIENTS.find((c) => c.id === id.toLowerCase());
}

/** Concrete MCP server entry, format-agnostic, before rendering to JSON/TOML. */
export interface ServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BuildSpecInput {
  name?: string;
  statewaveUrl?: string;
  tenantId?: string;
  /**
   * Absolute path to a local mcp-server bin to launch instead of fetching the
   * published package via npx. Used for dev/testing and by `quickstart`, which
   * points the client at the server it ships with.
   */
  serverBin?: string;
  /** Command to launch `serverBin` (defaults to the current Node executable). */
  serverCommand?: string;
}

/**
 * Build the server spec. We deliberately keep secrets (API keys) OUT of the
 * generated config — `STATEWAVE_API_KEY` is read from the process environment
 * by the server, so it never lands in a file that might be committed. URL and
 * tenant id are not secrets and are safe to write.
 */
export function buildServerSpec(input: BuildSpecInput = {}): ServerSpec {
  const env: Record<string, string> = {
    STATEWAVE_URL: input.statewaveUrl ?? DEFAULT_STATEWAVE_URL,
  };
  if (input.tenantId) env.STATEWAVE_TENANT_ID = input.tenantId;
  // A local bin runs via the current Node executable (absolute path) so GUI
  // clients with no shell PATH still launch it; otherwise fetch via npx.
  const [command, args] = input.serverBin
    ? [input.serverCommand ?? process.execPath, [input.serverBin]]
    : ["npx", ["-y", MCP_SERVER_PACKAGE]];
  return {
    name: input.name ?? DEFAULT_SERVER_NAME,
    command,
    args,
    env,
  };
}

/** The JSON entry value for a single server (the part under the server name). */
export function jsonEntry(spec: ServerSpec, client: ClientDef): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (client.jsonEntryType) entry.type = client.jsonEntryType;
  entry.command = spec.command;
  entry.args = spec.args;
  entry.env = spec.env;
  return entry;
}

/**
 * The minimal JSON object a user would merge into the client config: just the
 * container key holding this one server. Rendered with 2-space indent so it
 * matches what the merge writer produces.
 */
export function renderJsonBlock(spec: ServerSpec, client: ClientDef): string {
  const containerKey = client.containerKey ?? "mcpServers";
  const obj = { [containerKey]: { [spec.name]: jsonEntry(spec, client) } };
  return JSON.stringify(obj, null, 2) + "\n";
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The Codex-style TOML table for a single server. */
export function renderTomlBlock(spec: ServerSpec): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${spec.name}]`);
  lines.push(`command = ${tomlString(spec.command)}`);
  lines.push(`args = [${spec.args.map(tomlString).join(", ")}]`);
  const envPairs = Object.entries(spec.env)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join(", ");
  lines.push(`env = { ${envPairs} }`);
  return lines.join("\n") + "\n";
}
