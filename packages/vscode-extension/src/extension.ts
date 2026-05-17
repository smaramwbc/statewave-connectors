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
  autoIngestChanges,
} from "./commands.js";
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
  );

  // Make the Statewave memory runtime available to the assistant as the
  // always-present project brain — from the same single config block, with
  // no MCP file to hand-edit and no container to run.
  context.subscriptions.push(wireMcp(context));

  reconcileWatcher();

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
  if (!config.autoIndex || !folder) return;

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
