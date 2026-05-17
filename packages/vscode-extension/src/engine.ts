import * as vscode from "vscode";
import {
  CompileScheduler,
  deriveStatus,
  compileSubject,
  createIngestClient,
  resolveSubject,
  readGitContext,
  type CompileReason,
  type StatusPhase,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { StatusBar } from "./statusbar.js";
import { log } from "./output.js";

/**
 * Central, single source of truth for the trust surface. Commands, the
 * watcher and the MCP wiring all feed it; it owns the compile scheduler and
 * pushes a derived status to the status bar in real time.
 *
 * Deterministic freshness: a compile is (re)scheduled after ingest, on
 * window focus, on an idle interval, and on demand — coalesced + throttled
 * by the scheduler so it never blocks the UI and the user never has to
 * wonder whether a captured fact became memory.
 */
class Engine implements vscode.Disposable {
  private statusBar = new StatusBar();
  private phase: StatusPhase = "initializing";
  private online: boolean | undefined;
  private memories: number | undefined;
  private errors = 0;
  private lastBuildAt: number | undefined;
  private subject: string | undefined;
  private dirtySinceCompile = false;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private context: vscode.ExtensionContext | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /** Workspace-scoped persistence (incremental cache, code index). */
  wsGet<T>(key: string): T | undefined {
    return this.context?.workspaceState.get<T>(key);
  }
  async wsSet(key: string, value: unknown): Promise<void> {
    await this.context?.workspaceState.update(key, value);
  }
  /** Global persistence (first-run flag). */
  globalGet<T>(key: string): T | undefined {
    return this.context?.globalState.get<T>(key);
  }
  async globalSet(key: string, value: unknown): Promise<void> {
    await this.context?.globalState.update(key, value);
  }

  private scheduler = new CompileScheduler({
    minIntervalMs: 30_000,
    debounceMs: 2_000,
    compile: async () => this.doCompile(),
    onChange: () => this.render(),
  });

  init(context: vscode.ExtensionContext): void {
    this.context = context;
    this.disposables.push(
      this.statusBar,
      { dispose: () => this.scheduler.dispose() },
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && this.dirtySinceCompile) this.scheduler.request("focus");
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("statewave")) void this.refreshServer();
      }),
    );
    // Idle safety-net: if episodes were ingested and nothing compiled them,
    // do it after a quiet interval (assistant-driven ingests land here too).
    this.idleTimer = setInterval(() => {
      if (this.dirtySinceCompile) this.scheduler.request("idle-interval");
    }, 120_000);
    this.disposables.push({ dispose: () => clearInterval(this.idleTimer) });
    context.subscriptions.push(this);

    this.setPhase("idle");
    void this.refreshServer();
  }

  setPhase(phase: StatusPhase): void {
    this.phase = phase;
    this.render();
  }
  noteError(): void {
    this.errors += 1;
    this.render();
  }
  clearErrors(): void {
    this.errors = 0;
    this.render();
  }
  setMemories(n: number | undefined): void {
    this.memories = n;
    this.render();
  }
  markBuilt(): void {
    this.lastBuildAt = Date.now();
  }
  /** Episodes were ingested (by us or, via focus/idle, by the assistant). */
  markDirty(): void {
    this.dirtySinceCompile = true;
  }
  requestCompile(reason: CompileReason): void {
    this.dirtySinceCompile = true;
    this.scheduler.request(reason);
  }
  snapshotForStatus(): {
    phase: StatusPhase;
    online: boolean | undefined;
    memories: number | undefined;
    errors: number;
    lastBuildAt: number | undefined;
    subject: string | undefined;
    compile: ReturnType<CompileScheduler["snapshot"]>;
  } {
    return {
      phase: this.phase,
      online: this.online,
      memories: this.memories,
      errors: this.errors,
      lastBuildAt: this.lastBuildAt,
      subject: this.subject,
      compile: this.scheduler.snapshot(),
    };
  }

  /** Best-effort reachability probe — any HTTP response means reachable. */
  async refreshServer(): Promise<void> {
    const cfg = readConfig();
    if (!cfg.url) {
      this.online = undefined;
      this.render();
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    try {
      await fetch(cfg.url, { method: "GET", signal: ctrl.signal });
      this.online = true;
    } catch {
      this.online = false;
    } finally {
      clearTimeout(t);
      this.render();
    }
  }

  private async resolveSubjectNow(): Promise<string | undefined> {
    const folder = primaryWorkspaceFolder();
    if (!folder) return undefined;
    const cfg = readConfig();
    const git = await readGitContext(folder.uri.fsPath);
    const s = resolveSubject({
      config: cfg,
      remoteUrl: git.remoteUrl,
      folderName: folder.name,
    });
    this.subject = s ?? undefined;
    return s ?? undefined;
  }

  private async doCompile(): Promise<void> {
    const cfg = readConfig();
    if (!cfg.url) return;
    const subject = await this.resolveSubjectNow();
    if (!subject) return;
    const client = createIngestClient({ url: cfg.url, apiKey: cfg.apiKey });
    log(`compile (scheduled): ${subject}`);
    await compileSubject(client, subject);
    this.dirtySinceCompile = false;
  }

  private render(): void {
    const s = this.scheduler.snapshot();
    this.statusBar.update(
      deriveStatus({
        phase: this.phase,
        online: this.online,
        memories: this.memories,
        compile: s.state,
        errors: this.errors,
        subject: this.subject,
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

export const engine = new Engine();
