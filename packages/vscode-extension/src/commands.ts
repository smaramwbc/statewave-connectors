import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import {
  scanWorkspace,
  readGitContext,
  resolveSubject,
  buildProjectSummary,
  renderProjectSummaryText,
  isArchitectureDoc,
  isDocLike,
  workspaceIndexedEpisode,
  projectSummaryEpisode,
  gitContextEpisode,
  docsDetectedEpisode,
  architectureDetectedEpisode,
  fileChangedEpisode,
  diagnosticsReportedEpisode,
  docsContentEpisodes,
  gitHistoryEpisode,
  codeStructureEpisode,
  createIngestClient,
  ingestEpisodesParallel,
  compileSubject,
  CancellationFlag,
  diffScan,
  type ChangedFile,
  type IdeCompanionConfig,
  type StatewaveEpisode,
  type IndexCacheData,
  type CodeFileStructure,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { engine } from "./engine.js";
import { collectDiagnostics } from "./diagnostics.js";
import {
  collectGitHistory,
  collectCodeStructure,
  collectDocContents,
} from "./collect.js";
import { log, previewEpisodes, reportOutcome, reportCompile } from "./output.js";

const ARCH_DOC_MAX_BYTES = 256 * 1024;

interface ResolvedContext {
  root: string;
  folderName: string;
  config: IdeCompanionConfig;
  subject: string;
}

/** Resolve folder + config + subject, or surface actionable guidance. */
async function resolveContext(): Promise<ResolvedContext | undefined> {
  const folder = primaryWorkspaceFolder();
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Statewave: open a folder/workspace first — there is nothing to index.",
    );
    return undefined;
  }
  const config = readConfig();
  const root = folder.uri.fsPath;
  const git = await readGitContext(root);
  const subject = resolveSubject({
    config,
    remoteUrl: git.remoteUrl,
    folderName: folder.name,
  });
  if (!subject) {
    void vscode.window.showErrorMessage(
      config.subjectStrategy === "repo"
        ? "Statewave: subjectStrategy is 'repo' but no git remote was detected. Add a remote, set statewave.subject, or use the 'auto'/'workspace' strategy."
        : "Statewave: subjectStrategy is 'custom' but statewave.subject is empty. Set statewave.subject.",
    );
    return undefined;
  }
  return { root, folderName: folder.name, config, subject };
}

/** Map a full workspace scan + git + diagnostics into the canonical episodes. */
async function buildProjectEpisodes(
  ctx: ResolvedContext,
): Promise<StatewaveEpisode[]> {
  const { root, config, subject } = ctx;
  const scan = await scanWorkspace(root, {
    includeGlobs: config.includeGlobs,
    excludeGlobs: config.excludeGlobs,
  });
  // Incremental: only changed files drive the expensive enrich passes.
  // First run (no cache) → everything is "changed" → full build.
  const prevCache = engine.wsGet<IndexCacheData>("statewave.indexCache");
  const diff = diffScan(prevCache, scan.files);
  await engine.wsSet("statewave.indexCache", diff.next);
  const changedSet = new Set(diff.changed.map((f) => f.relativePath));
  log(
    `index cache: ${diff.changed.length} changed, ${diff.unchanged} unchanged, ${diff.removed.length} removed`,
  );

  const git = await readGitContext(root);
  const summary = buildProjectSummary(scan, git, subject);
  const redactionEnabled = config.redactionEnabled;

  const episodes: StatewaveEpisode[] = [
    workspaceIndexedEpisode({ subject, redactionEnabled, scan }),
    projectSummaryEpisode({ subject, redactionEnabled, summary }),
    gitContextEpisode({ subject, redactionEnabled, git }),
  ];

  const docs = scan.files.filter((f) => isDocLike(f.category));
  if (docs.length > 0) {
    episodes.push(docsDetectedEpisode({ subject, redactionEnabled, docs }));
  }

  for (const f of scan.files.filter((x) => isArchitectureDoc(x.category))) {
    let content: string | undefined;
    try {
      const stat = await fs.stat(f.absolutePath);
      if (stat.size <= ARCH_DOC_MAX_BYTES) {
        content = await fs.readFile(f.absolutePath, "utf8");
      }
    } catch {
      content = undefined;
    }
    episodes.push(
      architectureDetectedEpisode({
        subject,
        redactionEnabled,
        doc: { relativePath: f.relativePath, hash: f.hash, content },
      }),
    );
  }

  const diagnostics = collectDiagnostics(root);
  if (diagnostics.length > 0) {
    episodes.push(
      diagnosticsReportedEpisode({ subject, redactionEnabled, diagnostics }),
    );
  }

  // --- richer detail: full doc content, git history, code structure ---

  // Full content for README + plain docs. ADR/RFC/decision already carry
  // their full body via ide.architecture.detected, so exclude them here to
  // avoid ingesting the same text twice under two kinds.
  // Only re-read/re-send docs whose content changed; unchanged docs are
  // already memory (content-addressable). On first run everything is changed.
  const contentDocs = scan.files.filter(
    (f) =>
      isDocLike(f.category) &&
      !isArchitectureDoc(f.category) &&
      changedSet.has(f.relativePath),
  );
  const docFiles = await collectDocContents(contentDocs);
  if (docFiles.length > 0) {
    episodes.push(
      ...docsContentEpisodes({ subject, redactionEnabled, docs: docFiles }),
    );
  }

  const commits = await collectGitHistory(root);
  if (commits.length > 0) {
    episodes.push(gitHistoryEpisode({ subject, redactionEnabled, commits }));
  }

  // Code structure: extract symbols only for changed source files, then
  // rebuild the aggregate from a persisted symbol index (changed entries
  // updated, deleted files dropped). Avoids re-running the symbol provider
  // over the whole repo on every build.
  const changedSource = scan.files.filter(
    (f) => f.category === "source" && changedSet.has(f.relativePath),
  );
  const freshlyExtracted = await collectCodeStructure(changedSource);
  const codeIndex =
    engine.wsGet<Record<string, CodeFileStructure>>("statewave.codeIndex") ?? {};
  for (const cf of freshlyExtracted) codeIndex[cf.relativePath] = cf;
  const liveSourcePaths = new Set(
    scan.files.filter((f) => f.category === "source").map((f) => f.relativePath),
  );
  for (const p of Object.keys(codeIndex)) {
    if (!liveSourcePaths.has(p)) delete codeIndex[p];
  }
  await engine.wsSet("statewave.codeIndex", codeIndex);
  const mergedCodeFiles = Object.values(codeIndex);
  if (mergedCodeFiles.length > 0) {
    episodes.push(
      codeStructureEpisode({
        subject,
        redactionEnabled,
        files: mergedCodeFiles,
      }),
    );
  }

  return episodes;
}

/**
 * Preview is mandatory; sending is an explicit, separate click. Nothing is
 * ever ingested without the user pressing the action button here — this is
 * the single ingestion gate for every command.
 */
async function previewThenMaybeIngest(
  title: string,
  ctx: ResolvedContext,
  episodes: ReadonlyArray<StatewaveEpisode>,
): Promise<void> {
  previewEpisodes(title, ctx.subject, episodes);

  if (episodes.length === 0) {
    void vscode.window.showInformationMessage(
      "Statewave: nothing to ingest — no episodes were produced.",
    );
    return;
  }

  if (!ctx.config.url) {
    void vscode.window.showInformationMessage(
      `Statewave: previewed ${episodes.length} episode(s) for ${ctx.subject}. Set statewave.url to enable ingestion. See the “Statewave IDE Companion” output channel.`,
      "Open Output",
    ).then((pick) => {
      if (pick === "Open Output") void vscode.commands.executeCommand("workbench.action.output.toggleOutput");
    });
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Statewave: previewed ${episodes.length} episode(s) for ${ctx.subject}. Send them to ${ctx.config.url}?`,
    { modal: false },
    "Ingest to Statewave",
    "Show Preview",
  );

  if (choice === "Show Preview") {
    void vscode.commands.executeCommand("workbench.action.output.toggleOutput");
    return;
  }
  if (choice !== "Ingest to Statewave") return; // dismissed → stays a dry-run

  await doIngest(ctx.config, episodes);
}

async function doIngest(
  config: IdeCompanionConfig,
  episodes: ReadonlyArray<StatewaveEpisode>,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Statewave: ingesting…",
      cancellable: true,
    },
    async (progress, token) => {
      engine.setPhase("syncing");
      const cancel = new CancellationFlag();
      token.onCancellationRequested(() => cancel.cancel());
      try {
        const client = createIngestClient({ url: config.url, apiKey: config.apiKey });
        const total = episodes.length;
        const outcome = await ingestEpisodesParallel(episodes, {
          dryRun: false,
          client,
          concurrency: 6,
          cancel,
          onProgress: (p) =>
            progress.report({
              message: `${p.done}/${total} (${p.failed} failed)`,
              increment: (1 / total) * 100,
            }),
        });
        reportOutcome(outcome);
        engine.markBuilt();

        if (outcome.failed > 0) engine.noteError();
        else engine.clearErrors();

        // Compile is now async + scheduled — it NEVER blocks this notification.
        // The status bar shows compile pending/compiling/ready so the user
        // always knows whether the memory is queryable yet.
        let note = "";
        if (config.compileAfterIngest && outcome.ingested > 0) {
          engine.requestCompile("ingest-completed");
          note = " Compiling memory in the background (see the status bar).";
        } else if (outcome.ingested > 0) {
          engine.markDirty();
        }

        if (outcome.cancelled) {
          void vscode.window.showWarningMessage(
            `Statewave: cancelled — ${outcome.ingested}/${outcome.attempted} ingested.`,
          );
        } else if (outcome.failed > 0) {
          void vscode.window.showWarningMessage(
            `Statewave: ingested ${outcome.ingested}/${outcome.attempted}; ${outcome.failed} failed.${note} See output.`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `Statewave: ingested ${outcome.ingested} episode(s).${note}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`ingest error: ${msg}`);
        engine.noteError();
        void vscode.window.showErrorMessage(`Statewave: ingest failed — ${msg}`);
      } finally {
        engine.setPhase("idle");
      }
    },
  );
}

// ---- command handlers ----

export async function buildProjectMemory(): Promise<void> {
  const ctx = await resolveContext();
  if (!ctx) return;
  log(`build project memory — subject=${ctx.subject} root=${ctx.root}`);
  engine.setPhase("indexing");
  try {
    const episodes = await buildProjectEpisodes(ctx);
    engine.setPhase("idle");
    await previewThenMaybeIngest("Build Project Memory", ctx, episodes);
  } finally {
    engine.setPhase("idle");
  }
}

/**
 * Map a batch of changed files (from the watcher's drain, or — when there is
 * nothing pending — a fresh scan delta is not attempted; we just tell the
 * user). Always preview-first; ingestion is the explicit button.
 */
export async function syncChangedFiles(
  pending: ReadonlyArray<ChangedFile>,
): Promise<void> {
  const ctx = await resolveContext();
  if (!ctx) return;
  if (pending.length === 0) {
    void vscode.window.showInformationMessage(
      "Statewave: no changed files pending. Save some files (or run Build Project Memory).",
    );
    return;
  }
  log(`sync changed files — ${pending.length} change(s) subject=${ctx.subject}`);
  const episodes = pending.map((change) =>
    fileChangedEpisode({
      subject: ctx.subject,
      redactionEnabled: ctx.config.redactionEnabled,
      change,
    }),
  );
  await previewThenMaybeIngest("Sync Changed Files", ctx, episodes);
}

export async function showProjectMemorySummary(): Promise<void> {
  const ctx = await resolveContext();
  if (!ctx) return;
  const scan = await scanWorkspace(ctx.root, {
    includeGlobs: ctx.config.includeGlobs,
    excludeGlobs: ctx.config.excludeGlobs,
  });
  const git = await readGitContext(ctx.root);
  const summary = buildProjectSummary(scan, git, ctx.subject);
  const md = renderProjectSummaryText(summary);
  const doc = await vscode.workspace.openTextDocument({
    content: md,
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Manual safety net: compile the workspace subject now. Useful because
 * assistant-driven `statewave_ingest_episode` calls (e.g. a captured "my
 * favorite color is red") go through the MCP server, not the extension, so
 * the extension's post-ingest auto-compile never fires for them. One click
 * here turns those raw episodes into retrievable memory.
 */
export async function compileProjectMemory(): Promise<void> {
  const ctx = await resolveContext();
  if (!ctx) return;
  if (!ctx.config.url) {
    void vscode.window.showErrorMessage(
      "Statewave: set statewave.url to compile memory.",
    );
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Statewave: compiling memory…" },
    async () => {
      try {
        const client = createIngestClient({ url: ctx.config.url, apiKey: ctx.config.apiKey });
        const compiled = await compileSubject(client, ctx.subject);
        reportCompile(compiled);
        void vscode.window.showInformationMessage(
          `Statewave: compiled ${ctx.subject} — status ${compiled.status}.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`compile error: ${msg}`);
        void vscode.window.showErrorMessage(`Statewave: compile failed — ${msg}`);
      }
    },
  );
}

export async function configureStatewave(): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "statewave",
  );
}

/** Status-bar click target: live info + one-click actions. */
export async function statusMenu(): Promise<void> {
  const s = engine.snapshotForStatus();
  const info = [
    `subject: ${s.subject ?? "(unresolved)"}`,
    `server: ${s.online === false ? "unreachable" : s.online ? "online" : "unknown"}`,
    `compile: ${s.compile.state}${s.compile.lastError ? ` (${s.compile.lastError})` : ""}`,
    s.errors > 0 ? `recent errors: ${s.errors}` : "no recent errors",
  ].join("  ·  ");

  type Item = vscode.QuickPickItem & { cmd?: string };
  const items: Item[] = [
    { label: info, kind: vscode.QuickPickItemKind.Separator },
    { label: "$(sync) Build Project Memory", cmd: "statewave.buildProjectMemory" },
    { label: "$(arrow-up) Sync Changed Files", cmd: "statewave.syncChangedFiles" },
    { label: "$(database) Compile Project Memory", cmd: "statewave.compileProjectMemory" },
    { label: "$(book) Open Project Understanding", cmd: "statewave.openProjectUnderstanding" },
    { label: "$(eye) Show Indexed Files", cmd: "statewave.showIndexedFiles" },
    { label: "$(pulse) Diagnose", cmd: "statewave.diagnose" },
    { label: "$(gear) Configure", cmd: "statewave.configureStatewave" },
  ];
  const pick = (await vscode.window.showQuickPick(items, {
    title: "Statewave",
    placeHolder: "Statewave actions",
  })) as Item | undefined;
  if (pick?.cmd) await vscode.commands.executeCommand(pick.cmd);
}

/**
 * Watcher → auto-ingest path. Only ever reached when `statewave.autoIndex`
 * is true AND a URL is configured. This is the *only* non-button ingestion,
 * and it exists solely because the user explicitly turned it on.
 */
export async function autoIngestChanges(
  pending: ReadonlyArray<ChangedFile>,
): Promise<void> {
  const folder = primaryWorkspaceFolder();
  if (!folder || pending.length === 0) return;
  const config = readConfig();
  if (!config.autoIndex || !config.url) return;
  const git = await readGitContext(folder.uri.fsPath);
  const subject = resolveSubject({
    config,
    remoteUrl: git.remoteUrl,
    folderName: folder.name,
  });
  if (!subject) return;
  const episodes = pending.map((change) =>
    fileChangedEpisode({
      subject,
      redactionEnabled: config.redactionEnabled,
      change,
    }),
  );
  log(`autoIndex: ingesting ${episodes.length} ide.file.changed episode(s)`);
  await doIngest(config, episodes);
}
