import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  STATEWAVE_MCP_KEY,
  STATEWAVE_MCP_LABEL,
  buildStdioEntry,
  mergeCursorConfig,
  mergeClaudeProjectConfig,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { log } from "./output.js";

/**
 * "The plugin owns the MCP wiring."
 *
 * The developer sets `statewave.url` / `statewave.apiKey` once. From that
 * single source we make Statewave's memory runtime available to the
 * assistant as the always-present project brain — with no second config to
 * hand-edit and no container to run:
 *
 *  - VS Code (Copilot agent): register an MCP server *in-memory* via the
 *    VS Code MCP provider API. The API key is injected into the spawned
 *    server's env at provide-time and is NEVER written to disk.
 *  - Cursor: merge our entry into the user's *global* `~/.cursor/mcp.json`
 *    (home dir, never the repo) so nothing secret lands in version control.
 *
 * Everything is feature-detected and best-effort: a failure here never
 * breaks activation, and old editors simply fall back to manual config.
 */

// --- forward declarations of the VS Code >= 1.101 MCP provider API ---
// Declared locally so the extension still type-checks against older
// @types/vscode and still installs on older editors (runtime feature-detect).
interface McpServerDefinitionProviderLike {
  onDidChangeMcpServerDefinitions?: vscode.Event<void>;
  provideMcpServerDefinitions: () => Thenable<object[]> | object[];
  resolveMcpServerDefinition?: (server: object) => object;
}
interface VscodeLmMcp {
  registerMcpServerDefinitionProvider(
    id: string,
    provider: McpServerDefinitionProviderLike,
  ): vscode.Disposable;
}
type McpStdioCtor = new (opts: {
  label: string;
  command: string;
  args: string[];
  cwd?: vscode.Uri;
  env?: Record<string, string>;
  version?: string;
}) => object;

function lmMcp(): VscodeLmMcp | undefined {
  const lm = (vscode as unknown as { lm?: Partial<VscodeLmMcp> }).lm;
  return lm && typeof lm.registerMcpServerDefinitionProvider === "function"
    ? (lm as VscodeLmMcp)
    : undefined;
}
function stdioCtor(): McpStdioCtor | undefined {
  const ctor = (vscode as unknown as { McpStdioServerDefinition?: McpStdioCtor })
    .McpStdioServerDefinition;
  return typeof ctor === "function" ? ctor : undefined;
}

function serverScript(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "dist", "mcp-stdio.cjs");
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const v = (context.extension?.packageJSON as { version?: string } | undefined)
    ?.version;
  return typeof v === "string" ? v : "0.1.0";
}

/**
 * Register the in-memory VS Code MCP server. Returns disposables + a
 * `refresh()` that re-publishes the definition when settings change.
 */
function registerVscodeProvider(
  context: vscode.ExtensionContext,
): { disposables: vscode.Disposable[]; refresh: () => void } | undefined {
  const lm = lmMcp();
  const Ctor = stdioCtor();
  if (!lm || !Ctor) return undefined;

  const didChange = new vscode.EventEmitter<void>();
  const provider: McpServerDefinitionProviderLike = {
    onDidChangeMcpServerDefinitions: didChange.event,
    provideMcpServerDefinitions: () => {
      const cfg = readConfig();
      if (!cfg.url) return []; // nothing configured → expose nothing
      const env: Record<string, string> = {
        // Run the bundled server with the editor's own Node — no `node` on
        // PATH required, nothing extra to install.
        ELECTRON_RUN_AS_NODE: "1",
        STATEWAVE_URL: cfg.url,
      };
      if (cfg.apiKey) env.STATEWAVE_API_KEY = cfg.apiKey;
      return [
        new Ctor({
          label: STATEWAVE_MCP_LABEL,
          command: process.execPath,
          args: [serverScript(context)],
          cwd: vscode.Uri.file(context.extensionPath),
          env,
          version: extensionVersion(context),
        }),
      ];
    },
    resolveMcpServerDefinition: (server) => server,
  };

  const reg = lm.registerMcpServerDefinitionProvider(
    STATEWAVE_MCP_KEY,
    provider,
  );
  log("MCP: registered in-memory VS Code provider (zero-config for Copilot).");
  return {
    disposables: [reg, didChange],
    refresh: () => didChange.fire(),
  };
}

/**
 * Merge our server into the user's global `~/.cursor/mcp.json`. Only when
 * Cursor is actually present (`~/.cursor` exists) so we never create that
 * directory on pure-VS Code machines. Best-effort; never throws.
 */
async function syncCursorConfig(context: vscode.ExtensionContext): Promise<void> {
  const cfg = readConfig();
  if (!cfg.url) return;

  const cursorDir = path.join(os.homedir(), ".cursor");
  try {
    const st = await fs.stat(cursorDir);
    if (!st.isDirectory()) return;
  } catch {
    return; // Cursor not installed → nothing to do
  }

  const file = path.join(cursorDir, "mcp.json");
  let existing: unknown = {};
  try {
    existing = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // File exists but is unparseable — do NOT clobber the user's servers.
      log(`MCP: ~/.cursor/mcp.json is not valid JSON; leaving it untouched.`);
      return;
    }
  }

  const entry = buildStdioEntry({
    command: "node", // Cursor spawns its own process; needs node on PATH
    serverScriptPath: serverScript(context),
    url: cfg.url,
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
  });
  const { config, changed } = mergeCursorConfig(existing, entry);
  if (!changed) return;

  try {
    await fs.mkdir(cursorDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
    log(`MCP: updated ~/.cursor/mcp.json (managed “${STATEWAVE_MCP_KEY}” server).`);
  } catch (err) {
    log(`MCP: could not write ~/.cursor/mcp.json: ${(err as Error).message}`);
  }
}

/**
 * Merge our server into Claude Code's **local scope** in `~/.claude.json`
 * (`projects["<abs-project-path>"].mcpServers.statewave`). Claude Code does
 * not read VS Code's MCP registry, so it needs its own config.
 *
 * Local scope is chosen deliberately: `~/.claude.json` is in the home dir
 * (never committed → no key in VCS), it has **no approval gate** (a project
 * `.mcp.json` would prompt), and Claude Code auto-loads it on the next
 * session. `~/.claude.json` is Claude Code's primary config, so this is
 * surgical and never clobbers it on parse failure. Best-effort; never throws.
 */
async function syncClaudeConfig(context: vscode.ExtensionContext): Promise<void> {
  const cfg = readConfig();
  if (!cfg.url) return;
  const folder = primaryWorkspaceFolder();
  if (!folder) return;

  const file = path.join(os.homedir(), ".claude.json");
  let existing: unknown;
  try {
    existing = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No ~/.claude.json → Claude Code not set up on this machine. Don't
      // fabricate Claude Code's primary config file.
      return;
    }
    log("MCP: ~/.claude.json is not valid JSON; leaving it untouched.");
    return;
  }

  const entry = buildStdioEntry({
    command: "node", // Claude Code spawns its own process; needs node on PATH
    serverScriptPath: serverScript(context),
    url: cfg.url,
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
  });
  const { config, changed } = mergeClaudeProjectConfig(
    existing,
    folder.uri.fsPath,
    entry,
  );
  if (!changed) return;

  try {
    await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
    log(
      `MCP: updated ~/.claude.json (local-scoped “${STATEWAVE_MCP_KEY}” server for this project). ` +
        "Start a new Claude Code session (or run /mcp) to load it, and ask it to call the " +
        "statewave_get_context tool explicitly the first time.",
    );
  } catch (err) {
    log(`MCP: could not write ~/.claude.json: ${(err as Error).message}`);
  }
}

/**
 * Entry point called from `activate`. Wires all client paths and returns a
 * single disposable; re-applies on relevant settings changes.
 */
export function wireMcp(context: vscode.ExtensionContext): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  let providerRefresh: (() => void) | undefined;

  const apply = (): void => {
    const cfg = readConfig();
    if (!cfg.mcpAutoWire) {
      log("MCP: statewave.mcp.autoWire is off — not wiring any client.");
      return;
    }
    if (providerRefresh) {
      providerRefresh();
    } else {
      const reg = registerVscodeProvider(context);
      if (reg) {
        disposables.push(...reg.disposables);
        providerRefresh = reg.refresh;
      } else {
        log(
          "MCP: this editor has no MCP provider API — Copilot users on older VS Code should configure manually (see docs/ide-memory.md). Cursor is still auto-wired.",
        );
      }
    }
    void syncCursorConfig(context);
    void syncClaudeConfig(context);
  };

  apply();

  disposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("statewave")) apply();
    }),
  );

  return vscode.Disposable.from(...disposables);
}
