import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { classifyFile, isIgnored, type ChangedFile } from "@statewavedev/ide-core";

const MAX_HASH_BYTES = 1024 * 1024;

export interface FileWatcherOptions {
  root: string;
  includeGlobs: ReadonlyArray<string>;
  excludeGlobs: ReadonlyArray<string>;
  debounceMs: number;
  /** Called with a debounced batch of changes. Never called with an empty batch. */
  onFlush: (changes: ChangedFile[]) => void;
}

/**
 * Debounced workspace file watcher.
 *
 * - Watches the workspace folder; ignores the default ignore set + lockfiles
 *   + `excludeGlobs`, honouring `includeGlobs` force-includes (all via
 *   `@statewavedev/ide-core`).
 * - Coalesces rapid saves: the latest event per path wins inside a debounce
 *   window, so a burst of formatter saves produces one `ide.file.changed`.
 * - **Never ingests.** It only emits batches; the extension decides whether
 *   to preview or (only when `statewave.autoIndex` is on) ingest.
 */
export class FileWatcher implements vscode.Disposable {
  private readonly pending = new Map<string, ChangedFile>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly watcher: vscode.FileSystemWatcher;
  private disposed = false;

  constructor(private readonly opts: FileWatcherOptions) {
    const folderUri = vscode.Uri.file(opts.root);
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folderUri, "**/*"),
    );
    this.watcher.onDidCreate((uri) => this.record(uri, "created"));
    this.watcher.onDidChange((uri) => this.record(uri, "saved"));
    this.watcher.onDidDelete((uri) => this.record(uri, "deleted"));
  }

  private rel(uri: vscode.Uri): string | null {
    if (uri.scheme !== "file") return null;
    const r = path.relative(this.opts.root, uri.fsPath).split(path.sep).join("/");
    if (!r || r.startsWith("..")) return null;
    return r;
  }

  private record(uri: vscode.Uri, changeType: ChangedFile["changeType"]): void {
    if (this.disposed) return;
    const rel = this.rel(uri);
    if (!rel) return;
    if (
      isIgnored(rel, {
        includeGlobs: this.opts.includeGlobs,
        excludeGlobs: this.opts.excludeGlobs,
      })
    ) {
      return;
    }

    void this.hashIfNeeded(uri.fsPath, changeType).then((hash) => {
      if (this.disposed) return;
      this.pending.set(rel, {
        relativePath: rel,
        absolutePath: uri.fsPath,
        changeType,
        category: classifyFile(rel),
        hash,
        occurredAt: new Date().toISOString(),
      });
      this.schedule();
    });
  }

  private async hashIfNeeded(
    abs: string,
    changeType: ChangedFile["changeType"],
  ): Promise<string | undefined> {
    if (changeType === "deleted") return undefined;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_HASH_BYTES) {
        return createHash("sha256")
          .update(`${abs}|${stat.size}|${stat.mtime.toISOString()}`)
          .digest("hex")
          .slice(0, 16);
      }
      const buf = await fs.readFile(abs);
      return createHash("sha256").update(buf).digest("hex").slice(0, 16);
    } catch {
      return undefined;
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs);
  }

  /** Emit the current batch immediately (used by the manual sync command). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.opts.onFlush(batch);
  }

  /** Drain pending changes without firing onFlush (manual command path). */
  drain(): ChangedFile[] {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = [...this.pending.values()];
    this.pending.clear();
    return batch;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.watcher.dispose();
    this.pending.clear();
  }
}
