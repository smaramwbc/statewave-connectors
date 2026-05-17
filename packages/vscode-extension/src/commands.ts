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
  createIngestClient,
  ingestEpisodes,
  type ChangedFile,
  type IdeCompanionConfig,
  type StatewaveEpisode,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { collectDiagnostics } from "./diagnostics.js";
import { log, previewEpisodes, reportOutcome } from "./output.js";

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
    { location: vscode.ProgressLocation.Notification, title: "Statewave: ingesting…" },
    async () => {
      try {
        const client = createIngestClient({ url: config.url, apiKey: config.apiKey });
        const outcome = await ingestEpisodes(episodes, { dryRun: false, client });
        reportOutcome(outcome);
        if (outcome.failed > 0) {
          void vscode.window.showWarningMessage(
            `Statewave: ingested ${outcome.ingested}/${outcome.attempted}; ${outcome.failed} failed. See output.`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `Statewave: ingested ${outcome.ingested} episode(s).`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`ingest error: ${msg}`);
        void vscode.window.showErrorMessage(`Statewave: ingest failed — ${msg}`);
      }
    },
  );
}

// ---- command handlers ----

export async function buildProjectMemory(): Promise<void> {
  const ctx = await resolveContext();
  if (!ctx) return;
  log(`build project memory — subject=${ctx.subject} root=${ctx.root}`);
  const episodes = await buildProjectEpisodes(ctx);
  await previewThenMaybeIngest("Build Project Memory", ctx, episodes);
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

export async function configureStatewave(): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "statewave",
  );
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
