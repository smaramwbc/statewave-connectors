import * as vscode from "vscode";
import {
  CompileScheduler,
  deriveStatus,
  compileSubject,
  createIngestClient,
  resolveSubject,
  readGitContext,
  nextProbeDelayMs,
  readyzUrl,
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
  private reconnecting = false;
  private memories: number | undefined;
  private errors = 0;
  private lastBuildAt: number | undefined;
  private subject: string | undefined;
  private dirtySinceCompile = false;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
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
        if (!e.affectsConfiguration("statewave")) return;
        // Subject derivation may have changed (subjectStrategy / subject);
        // drop the cache so the next probe re-resolves.
        this.subject = undefined;
        void (async () => {
          await this.refreshServer();
          void this.refreshMemoryCount("config-changed");
        })();
      }),
    );
    // Idle safety-net: if episodes were ingested and nothing compiled them,
    // do it after a quiet interval (assistant-driven ingests land here too).
    this.idleTimer = setInterval(() => {
      if (this.dirtySinceCompile) this.scheduler.request("idle-interval");
    }, 120_000);
    this.disposables.push({ dispose: () => clearInterval(this.idleTimer) });
    this.disposables.push({ dispose: () => this.clearProbeTimer() });
    context.subscriptions.push(this);

    this.setPhase("idle");
    // Kicks off the self-rescheduling reachability poll: probe now, then every
    // ~30s while offline / ~5min while online, so a server restart is noticed
    // automatically and the user never has to reload the window.
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
    reconnecting: boolean;
    memories: number | undefined;
    errors: number;
    lastBuildAt: number | undefined;
    subject: string | undefined;
    compile: ReturnType<CompileScheduler["snapshot"]>;
  } {
    return {
      phase: this.phase,
      online: this.online,
      reconnecting: this.reconnecting,
      memories: this.memories,
      errors: this.errors,
      lastBuildAt: this.lastBuildAt,
      subject: this.subject,
      compile: this.scheduler.snapshot(),
    };
  }

  private clearProbeTimer(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  /**
   * Schedule the next reachability probe. Self-rescheduling: ~30s while the
   * server is offline/unknown (fast recovery), ~5min while online (cheap
   * heartbeat). Coalesced — only ever one timer outstanding.
   */
  private scheduleNextProbe(): void {
    this.clearProbeTimer();
    const delay = nextProbeDelayMs(this.online);
    this.probeTimer = setTimeout(() => {
      void this.refreshServer();
    }, delay);
  }

  /**
   * Probe `/readyz` and update the online flag, then reschedule the next
   * probe. Sets the transient `reconnecting` flag so the status bar shows
   * "connecting…" during the probe (offline → connecting → online) instead of
   * a stuck "offline". Quiet — only the Output channel narrates; no toasts.
   */
  async refreshServer(): Promise<void> {
    const cfg = readConfig();
    if (!cfg.url) {
      this.online = undefined;
      this.reconnecting = false;
      this.clearProbeTimer();
      this.render();
      return;
    }
    const wasOnline = this.online;
    this.reconnecting = true;
    this.render();
    const url = readyzUrl(cfg.url);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      this.online = true;
      if (wasOnline !== true) {
        log(`reachability: ${url} → online (HTTP ${res.status})`);
        void this.refreshMemoryCount("online");
      }
    } catch (err) {
      this.online = false;
      if (wasOnline !== false) {
        log(`reachability: ${url} → unreachable (${(err as Error).message})`);
      }
    } finally {
      clearTimeout(t);
      this.reconnecting = false;
      this.render();
      this.scheduleNextProbe();
    }
  }

  /**
   * Manual `Statewave: Reconnect` — force an immediate probe, resetting the
   * poll cadence. Used by the command and the status menu.
   */
  async reconnect(): Promise<void> {
    log("reachability: manual reconnect requested");
    await this.refreshServer();
  }

  /** Last known reachability — for callers that must fail fast when offline. */
  isOnline(): boolean | undefined {
    return this.online;
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
    void this.refreshMemoryCount("post-compile");
  }

  /**
   * Probe how many compiled memories the current subject has, so the
   * status bar tooltip can show a real count instead of "Memory: unknown".
   * Lazy and best-effort: only runs when the server is known-online and a
   * subject is resolved; on failure the previous count stands (no flicker
   * back to "unknown"). limit=200 is a pragmatic cap — for typical
   * projects this is the full count; for very large ones the display caps,
   * which is still strictly more useful than "unknown".
   */
  private async refreshMemoryCount(reason: string): Promise<void> {
    const cfg = readConfig();
    if (!cfg.url || this.online !== true) return;
    const subject = this.subject ?? (await this.resolveSubjectNow());
    if (!subject) return;
    try {
      const client = createIngestClient({ url: cfg.url, apiKey: cfg.apiKey });
      const results = await client.searchMemories({
        query: "",
        subject,
        limit: 200,
      });
      this.memories = results.length;
      this.render();
    } catch (err) {
      log(`memory-count probe (${reason}) failed: ${(err as Error).message}`);
    }
  }

  private render(): void {
    const s = this.scheduler.snapshot();
    this.statusBar.update(
      deriveStatus({
        phase: this.phase,
        online: this.online,
        reconnecting: this.reconnecting,
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
