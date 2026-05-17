import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  STATEWAVE_MCP_KEY,
  STATEWAVE_MCP_LABEL,
  buildStdioEntry,
  mergeMcpServersConfig,
  mergeClaudeProjectConfig,
  removeMcpServer,
  removeClaudeProjectServer,
  renderContinueYaml,
  type McpStdioEntry,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { syncAgentInstructions } from "./instructions.js";
import { log } from "./output.js";

/**
 * "The plugin owns the MCP wiring" — for every assistant the developer might
 * use, from the single `statewave.url`/`apiKey` they set once. The Statewave
 * memory runtime becomes the always-present project brain so the assistant
 * makes fewer mistakes — no MCP file to hand-edit, no container to run.
 *
 * Safety rules that hold for every target:
 *  - Only act when that client is actually installed (its config dir/file
 *    already exists) — never fabricate another tool's primary config.
 *  - Secrets only ever land in home-dir / editor-storage files, never in the
 *    repository.
 *  - Surgical merge: our single `statewave` entry, everything else preserved.
 *  - Never clobber a file that failed to parse.
 *  - Idempotent: unchanged → no write, no churn.
 *  - Best-effort: a failure here never breaks activation.
 */

// --- forward declarations of the VS Code >= 1.101 MCP provider API ---
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

/** All wirable clients. `copilot` is the in-memory provider; the rest are files. */
export const ALL_MCP_CLIENTS = [
  "copilot",
  "cursor",
  "windsurf",
  "claude",
  "cline",
  "roo",
  "continue",
] as const;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

interface JsonRead {
  data: unknown;
  missing: boolean;
  parseError: boolean;
}
async function readJsonSafe(file: string): Promise<JsonRead> {
  try {
    return { data: JSON.parse(await fs.readFile(file, "utf8")), missing: false, parseError: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { data: {}, missing: true, parseError: false };
    }
    return { data: {}, missing: false, parseError: true };
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Find an installed extension's globalStorage dir, host- and case-robust. */
async function extStorageDir(
  context: vscode.ExtensionContext,
  extIdLower: string,
): Promise<string | undefined> {
  const base = path.dirname(context.globalStorageUri.fsPath); // .../globalStorage
  try {
    for (const name of await fs.readdir(base)) {
      if (name.toLowerCase() === extIdLower) return path.join(base, name);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

interface SyncResult {
  /** Newly applied or changed → worth telling the user about. */
  acted: boolean;
  /** Extra one-time guidance (Continue with a pre-existing config). */
  note?: string;
}

const NOOP: SyncResult = { acted: false };

/** Generic merge-write for the shared `{ mcpServers: { … } }` clients. */
async function syncMcpServersFile(
  file: string,
  entry: McpStdioEntry,
  who: string,
): Promise<SyncResult> {
  const read = await readJsonSafe(file);
  if (read.parseError) {
    log(`MCP: ${file} is not valid JSON — leaving ${who} untouched.`);
    return NOOP;
  }
  const { config, changed } = mergeMcpServersConfig(read.data, entry);
  if (!changed) return NOOP;
  try {
    await writeJson(file, config);
    log(`MCP: wired ${who} → ${file}`);
    return { acted: true };
  } catch (err) {
    log(`MCP: could not write ${file}: ${(err as Error).message}`);
    return NOOP;
  }
}

function nodeEntry(
  context: vscode.ExtensionContext,
  url: string,
  apiKey?: string,
): McpStdioEntry {
  // External clients spawn their own process → `node` on PATH (devs have it).
  return buildStdioEntry({
    command: "node",
    serverScriptPath: serverScript(context),
    url,
    ...(apiKey ? { apiKey } : {}),
  });
}

// ---- per-client file sync ----

async function syncCursor(c: Ctx): Promise<SyncResult> {
  const dir = path.join(os.homedir(), ".cursor");
  if (!(await exists(dir))) return NOOP;
  return syncMcpServersFile(
    path.join(dir, "mcp.json"),
    nodeEntry(c.context, c.url, c.apiKey),
    "Cursor (~/.cursor/mcp.json)",
  );
}

async function syncWindsurf(c: Ctx): Promise<SyncResult> {
  const dir = path.join(os.homedir(), ".codeium", "windsurf");
  if (!(await exists(dir))) return NOOP;
  return syncMcpServersFile(
    path.join(dir, "mcp_config.json"),
    nodeEntry(c.context, c.url, c.apiKey),
    "Windsurf (~/.codeium/windsurf/mcp_config.json)",
  );
}

async function syncCline(c: Ctx): Promise<SyncResult> {
  const ext = await extStorageDir(c.context, "saoudrizwan.claude-dev");
  if (!ext) return NOOP;
  return syncMcpServersFile(
    path.join(ext, "settings", "cline_mcp_settings.json"),
    nodeEntry(c.context, c.url, c.apiKey),
    "Cline (globalStorage/saoudrizwan.claude-dev)",
  );
}

async function syncRoo(c: Ctx): Promise<SyncResult> {
  const ext = await extStorageDir(c.context, "rooveterinaryinc.roo-cline");
  if (!ext) return NOOP;
  return syncMcpServersFile(
    path.join(ext, "settings", "mcp_settings.json"),
    nodeEntry(c.context, c.url, c.apiKey),
    "Roo Code (globalStorage/RooVeterinaryInc.roo-cline)",
  );
}

async function syncClaude(c: Ctx): Promise<SyncResult> {
  const folder = primaryWorkspaceFolder();
  if (!folder) return NOOP;
  const file = path.join(os.homedir(), ".claude.json");
  if (!(await exists(file))) return NOOP; // don't fabricate Claude's primary config
  const read = await readJsonSafe(file);
  if (read.parseError) {
    log("MCP: ~/.claude.json is not valid JSON — leaving Claude Code untouched.");
    return NOOP;
  }
  const { config, changed } = mergeClaudeProjectConfig(
    read.data,
    folder.uri.fsPath,
    nodeEntry(c.context, c.url, c.apiKey),
  );
  if (!changed) return NOOP;
  try {
    await writeJson(file, config);
    log(
      "MCP: wired Claude Code (local scope in ~/.claude.json). Start a new Claude Code session (or /mcp) to load it.",
    );
    return { acted: true };
  } catch (err) {
    log(`MCP: could not write ~/.claude.json: ${(err as Error).message}`);
    return NOOP;
  }
}

async function syncContinue(c: Ctx): Promise<SyncResult> {
  const dir = path.join(os.homedir(), ".continue");
  if (!(await exists(dir))) return NOOP;
  const file = path.join(dir, "config.yaml");
  const yaml = renderContinueYaml(nodeEntry(c.context, c.url, c.apiKey));
  if (await exists(file)) {
    // YAML merge needs a parser (ide-core is zero-dep) and we won't risk the
    // user's Continue config — guide a one-time paste instead of rewriting.
    log(
      "MCP: Continue config exists — add this block to ~/.continue/config.yaml:\n" +
        yaml.snippet,
    );
    return {
      acted: false,
      note: "Continue: paste the snippet from the output channel into ~/.continue/config.yaml.",
    };
  }
  try {
    await fs.writeFile(file, yaml.file, "utf8");
    log("MCP: wired Continue (created ~/.continue/config.yaml).");
    return { acted: true };
  } catch (err) {
    log(`MCP: could not write ~/.continue/config.yaml: ${(err as Error).message}`);
    return NOOP;
  }
}

interface Ctx {
  context: vscode.ExtensionContext;
  url: string;
  apiKey?: string;
}

const FILE_TARGETS: ReadonlyArray<{
  id: (typeof ALL_MCP_CLIENTS)[number];
  label: string;
  sync: (c: Ctx) => Promise<SyncResult>;
}> = [
  { id: "cursor", label: "Cursor", sync: syncCursor },
  { id: "windsurf", label: "Windsurf", sync: syncWindsurf },
  { id: "claude", label: "Claude Code", sync: syncClaude },
  { id: "cline", label: "Cline", sync: syncCline },
  { id: "roo", label: "Roo Code", sync: syncRoo },
  { id: "continue", label: "Continue", sync: syncContinue },
];

/** In-memory VS Code/Copilot provider (no disk, key stays in memory). */
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
      if (!cfg.url) return [];
      const env: Record<string, string> = {
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
  const reg = lm.registerMcpServerDefinitionProvider(STATEWAVE_MCP_KEY, provider);
  log("MCP: registered in-memory VS Code provider (zero-config for Copilot).");
  return { disposables: [reg, didChange], refresh: () => didChange.fire() };
}

async function notifyOnce(
  context: vscode.ExtensionContext,
  wired: string[],
  notes: string[],
): Promise<void> {
  if (wired.length === 0 && notes.length === 0) return;
  const signature = JSON.stringify({ wired: [...wired].sort(), notes: notes.sort() });
  const KEY = "statewave.mcp.wiredSignature";
  if (context.globalState.get<string>(KEY) === signature) return;
  await context.globalState.update(KEY, signature);

  const summary =
    wired.length > 0
      ? `Statewave wired project memory into: ${wired.join(", ")}.`
      : "Statewave: MCP wiring needs one manual step.";
  const pick = await vscode.window.showInformationMessage(
    notes.length > 0 ? `${summary} ${notes.join(" ")}` : summary,
    "Show details",
  );
  if (pick === "Show details") {
    void vscode.commands.executeCommand("workbench.action.output.toggleOutput");
  }
}

/**
 * Reset: remove our managed `statewave` MCP server from every client config
 * we may have written. Surgical (only our key), best-effort. Continue is
 * left alone (we only ever created it when absent).
 */
export async function removeStatewaveMcp(
  context: vscode.ExtensionContext,
): Promise<string[]> {
  const removed: string[] = [];
  const home = os.homedir();
  const jsonTargets: Array<{ label: string; file: string }> = [
    { label: "Cursor", file: path.join(home, ".cursor", "mcp.json") },
    {
      label: "Windsurf",
      file: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
    },
  ];
  const cline = await extStorageDir(context, "saoudrizwan.claude-dev");
  if (cline) {
    jsonTargets.push({
      label: "Cline",
      file: path.join(cline, "settings", "cline_mcp_settings.json"),
    });
  }
  const roo = await extStorageDir(context, "rooveterinaryinc.roo-cline");
  if (roo) {
    jsonTargets.push({
      label: "Roo Code",
      file: path.join(roo, "settings", "mcp_settings.json"),
    });
  }
  for (const t of jsonTargets) {
    const read = await readJsonSafe(t.file);
    if (read.missing || read.parseError) continue;
    const { config, changed } = removeMcpServer(read.data);
    if (changed) {
      try {
        await writeJson(t.file, config);
        removed.push(t.label);
      } catch {
        /* ignore */
      }
    }
  }
  const folder = primaryWorkspaceFolder();
  const claudeFile = path.join(home, ".claude.json");
  const cr = await readJsonSafe(claudeFile);
  if (folder && !cr.missing && !cr.parseError) {
    const { config, changed } = removeClaudeProjectServer(
      cr.data,
      folder.uri.fsPath,
    );
    if (changed) {
      try {
        await writeJson(claudeFile, config);
        removed.push("Claude Code");
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

/**
 * Entry point from `activate`. Wires every allowed client and returns one
 * disposable; re-applies on relevant settings changes.
 */
export function wireMcp(context: vscode.ExtensionContext): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  let providerRefresh: (() => void) | undefined;

  const apply = async (): Promise<void> => {
    const cfg = readConfig();
    if (!cfg.mcpAutoWire) {
      log("MCP: statewave.mcp.autoWire is off — not wiring any client.");
      return;
    }
    if (!cfg.url) {
      log("MCP: statewave.url is empty — nothing to wire (preview-only).");
      return;
    }
    const allow = new Set(cfg.mcpClients);
    const wired: string[] = [];
    const notes: string[] = [];

    if (allow.has("copilot")) {
      if (providerRefresh) {
        providerRefresh();
      } else {
        const reg = registerVscodeProvider(context);
        if (reg) {
          disposables.push(...reg.disposables);
          providerRefresh = reg.refresh;
          wired.push("Copilot");
        } else {
          log(
            "MCP: no VS Code MCP provider API (older editor) — Copilot users configure manually; other clients still auto-wired.",
          );
        }
      }
    }

    const c: Ctx = { context, url: cfg.url, apiKey: cfg.apiKey };
    for (const t of FILE_TARGETS) {
      if (!allow.has(t.id)) continue;
      try {
        const r = await t.sync(c);
        if (r.acted) wired.push(t.label);
        if (r.note) notes.push(r.note);
      } catch (err) {
        log(`MCP: ${t.label} wiring error: ${(err as Error).message}`);
      }
    }

    if (cfg.assistantInstructions !== "off") {
      try {
        const r = await syncAgentInstructions();
        if (r.wired.length > 0) {
          wired.push(`auto-instructions×${r.wired.length}`);
        }
      } catch (err) {
        log(`instructions: wiring error: ${(err as Error).message}`);
      }
    }

    await notifyOnce(context, wired, notes);
  };

  void apply();

  disposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("statewave")) void apply();
    }),
  );

  return vscode.Disposable.from(...disposables);
}
