import * as vscode from "vscode";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { FileWatcher } from "./watcher.js";
import {
  buildProjectMemory,
  syncChangedFiles,
  showProjectMemorySummary,
  compileProjectMemory,
  configureStatewave,
  statusMenu,
  reconnectCommand,
  autoIngestChanges,
} from "./commands.js";
import {
  diagnoseCommand,
  showIndexedFiles,
  openProjectUnderstanding,
  resetIntegration,
} from "./views.js";
import { syncGithubHistory } from "./github-sync.js";
import { wireMcp } from "./mcpWiring.js";
import { engine } from "./engine.js";
import { log, disposeChannel } from "./output.js";

const DEBOUNCE_MS = 1500;

let watcher: FileWatcher | undefined;

/**
 * Activated on workspace open (`onStartupFinished`). Activation itself does
 * nothing observable: no scan, no network, no ingestion. It only registers
 * commands and — when (and only when) `statewave.autoIndex` is enabled — a
 * debounced file watcher. Installing the extension can never start mirroring
 * data anywhere.
 */
export function activate(context: vscode.ExtensionContext): void {
  log("Statewave IDE Companion activated (no data is sent on activation).");

  // Trust surface + deterministic compile scheduler. Reads/derives only;
  // never ingests on activation.
  engine.init(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("statewave.statusMenu", () =>
      run(statusMenu()),
    ),
    vscode.commands.registerCommand("statewave.reconnect", () =>
      run(reconnectCommand()),
    ),
    vscode.commands.registerCommand("statewave.buildProjectMemory", () =>
      run(buildProjectMemory()),
    ),
    vscode.commands.registerCommand("statewave.syncChangedFiles", () => {
      const pending = watcher ? watcher.drain() : [];
      return run(syncChangedFiles(pending));
    }),
    vscode.commands.registerCommand("statewave.showProjectMemorySummary", () =>
      run(showProjectMemorySummary()),
    ),
    vscode.commands.registerCommand("statewave.compileProjectMemory", () =>
      run(compileProjectMemory()),
    ),
    vscode.commands.registerCommand("statewave.configureStatewave", () =>
      run(configureStatewave()),
    ),
    vscode.commands.registerCommand("statewave.diagnose", () =>
      run(diagnoseCommand()),
    ),
    vscode.commands.registerCommand("statewave.showIndexedFiles", () =>
      run(showIndexedFiles()),
    ),
    vscode.commands.registerCommand("statewave.openProjectUnderstanding", () =>
      run(openProjectUnderstanding()),
    ),
    vscode.commands.registerCommand("statewave.resetIntegration", () =>
      run(resetIntegration(context)),
    ),
    vscode.commands.registerCommand("statewave.syncGithubHistory", () =>
      run(syncGithubHistory()),
    ),
  );

  // First-run: open the walkthrough once. Opening a walkthrough is inert —
  // it never indexes or sends anything; the user drives every step.
  if (!engine.globalGet<boolean>("statewave.onboarded")) {
    void engine.globalSet("statewave.onboarded", true);
    void vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "statewavedev.statewave-ide-companion#statewaveGettingStarted",
      false,
    );
  }

  // Honour the declared `untrustedWorkspaces: limited` capability: the
  // side-effecting paths (MCP/instruction auto-writes, the watcher) run
  // only in a trusted workspace. Commands still work; nothing is hidden.
  let mcpWiring: vscode.Disposable | undefined;
  const applyTrustedBehavior = (): void => {
    if (!vscode.workspace.isTrusted) {
      log("Workspace not trusted — MCP wiring, instruction files and the watcher are disabled until you trust it.");
      return;
    }
    if (!mcpWiring) {
      mcpWiring = wireMcp(context);
      context.subscriptions.push(mcpWiring);
    }
    reconcileWatcher();
  };
  applyTrustedBehavior();
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => applyTrustedBehavior()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("statewave.autoIndex") ||
        e.affectsConfiguration("statewave.includeGlobs") ||
        e.affectsConfiguration("statewave.excludeGlobs")
      ) {
        reconcileWatcher();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => reconcileWatcher()),
    { dispose: () => stopWatcher() },
  );
}

export function deactivate(): void {
  stopWatcher();
  disposeChannel();
}

/**
 * Create the watcher only when `autoIndex` is on, otherwise tear it down. The
 * watcher batches changes and, because it is only constructed under
 * `autoIndex`, its flush path auto-ingests — the user's explicit opt-in.
 */
function reconcileWatcher(): void {
  const config = readConfig();
  const folder = primaryWorkspaceFolder();
  stopWatcher();
  if (!vscode.workspace.isTrusted || !config.autoIndex || !folder) return;

  watcher = new FileWatcher({
    root: folder.uri.fsPath,
    includeGlobs: config.includeGlobs,
    excludeGlobs: config.excludeGlobs,
    debounceMs: DEBOUNCE_MS,
    onFlush: (changes) => {
      void run(autoIngestChanges(changes));
    },
  });
  log("autoIndex enabled — debounced file watcher started.");
}

function stopWatcher(): void {
  watcher?.dispose();
  watcher = undefined;
}

/** Centralised error boundary so a failing command never crashes the host. */
async function run(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`command error: ${msg}`);
    void vscode.window.showErrorMessage(`Statewave: ${msg}`);
  }
}
