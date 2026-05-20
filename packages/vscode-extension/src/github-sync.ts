import * as vscode from "vscode";
import { createGithubConnector } from "@statewavedev/connectors-github";
import {
  CancellationFlag,
  applyRedaction,
  createIngestClient,
  ingestEpisodesParallel,
  readGitContext,
  resolveSubject,
  type StatewaveEpisode,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { engine } from "./engine.js";
import { log, previewEpisodes, reportOutcome } from "./output.js";

/**
 * `Statewave: Sync GitHub Project History` — opt-in, manual command.
 *
 * Fills the long-term-memory "why" gap the IDE plugin alone can't see:
 * pulls issues / PRs / comments / reviews / releases via
 * `@statewavedev/connectors-github` and ingests them under the same
 * sanitized subject as the rest of the workspace memory.
 *
 * Hard rules:
 *  - Off by default (`statewave.github.enabled`).
 *  - Manual only — never on activation / save / watcher loop (rate limits).
 *  - Preview-first; explicit Ingest click. Same UX as Build Project Memory.
 *  - Auth prefers VS Code's built-in `github` session (no token in settings);
 *    `statewave.github.token` is a fallback for Cursor / headless only.
 *  - Public repos sync unauthenticated (lower rate limits).
 */
export async function syncGithubHistory(): Promise<void> {
  const cfg = readConfig();
  if (!cfg.github.enabled) {
    void vscode.window.showInformationMessage(
      "Statewave: GitHub sync is off. Turn on statewave.github.enabled to use this command.",
    );
    return;
  }

  const folder = primaryWorkspaceFolder();
  if (!folder) {
    void vscode.window.showWarningMessage("Statewave: open a folder first.");
    return;
  }

  // 1. Resolve repo: explicit override or detect from git remote.
  const repo = await resolveRepo(folder.uri.fsPath, cfg.github.repo);
  if (!repo) {
    void vscode.window.showErrorMessage(
      "Statewave GitHub sync: could not resolve owner/name — set statewave.github.repo, or open a folder with a github.com remote.",
    );
    return;
  }

  // 2. Resolve the workspace subject (sanitized — server-safe).
  const git = await readGitContext(folder.uri.fsPath);
  const subject = resolveSubject({
    config: cfg,
    remoteUrl: git.remoteUrl,
    folderName: folder.name,
  });
  if (!subject) {
    void vscode.window.showErrorMessage(
      "Statewave GitHub sync: could not resolve a subject (see statewave.subjectStrategy).",
    );
    return;
  }

  // 3. Resolve token: settings override → VS Code github session → none.
  const token = await resolveToken(cfg.github.token);

  // 4. since: setting → persisted last-sync cursor → none.
  const since =
    cfg.github.since ??
    engine.wsGet<string>("statewave.github.lastSyncAt") ??
    undefined;

  log(
    `github-sync: repo=${repo.owner}/${repo.name} subject=${subject} include=${cfg.github.include.join(",")} since=${since ?? "(none)"} token=${token ? "yes" : "no (public-only)"}`,
  );

  // 5. Fetch from GitHub via the existing connector. Network happens here;
  //    NO ingestion (the connector returns episodes; we run them through
  //    our parallel ingest queue + scheduler).
  let episodes: ReadonlyArray<StatewaveEpisode>;
  try {
    const conn = createGithubConnector({
      repo: { owner: repo.owner, name: repo.name },
      ...(token ? { token } : {}),
      subject,
    });
    engine.setPhase("syncing");
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Statewave: pulling ${repo.owner}/${repo.name} from GitHub…`,
        cancellable: false,
      },
      () =>
        conn.sync({
          subject,
          ...(since ? { since } : {}),
          include: cfg.github.include,
          maxItems: cfg.github.maxItems,
          dryRun: true, // we ingest ourselves through the queue
          ...(cfg.redactionEnabled
            ? { redaction: { email: true, phone: true, secrets: true } }
            : {}),
        }),
    );
    episodes = result.episodes.map((ep) => applyRedaction(ep, cfg.redactionEnabled));
  } catch (err) {
    engine.setPhase("idle");
    engine.noteError();
    const msg = err instanceof Error ? err.message : String(err);
    log(`github-sync error: ${msg}`);
    void vscode.window.showErrorMessage(`Statewave GitHub sync: ${msg}`);
    return;
  }

  engine.setPhase("idle");

  if (episodes.length === 0) {
    void vscode.window.showInformationMessage(
      `Statewave: GitHub returned 0 new episodes for ${repo.owner}/${repo.name}${since ? ` since ${since}` : ""}.`,
    );
    return;
  }

  // 6. Preview + explicit Ingest (mirrors Build Project Memory UX).
  previewEpisodes(`GitHub history (${repo.owner}/${repo.name})`, subject, episodes);

  if (!cfg.url) {
    void vscode.window.showInformationMessage(
      `Statewave: previewed ${episodes.length} GitHub episode(s) for ${subject}. Set statewave.url to enable ingestion.`,
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Statewave: previewed ${episodes.length} GitHub episode(s) for ${subject}. Send them to ${cfg.url}?`,
    { modal: false },
    "Ingest to Statewave",
    "Show Preview",
  );
  if (choice === "Show Preview") {
    void vscode.commands.executeCommand("workbench.action.output.toggleOutput");
    return;
  }
  if (choice !== "Ingest to Statewave") return;

  // 7. Ingest through the existing parallel queue + scheduler.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Statewave: ingesting GitHub history…`,
      cancellable: true,
    },
    async (progress, token) => {
      engine.setPhase("syncing");
      const cancel = new CancellationFlag();
      token.onCancellationRequested(() => cancel.cancel());
      try {
        const client = createIngestClient({ url: cfg.url, apiKey: cfg.apiKey });
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

        if (outcome.ingested > 0) {
          await persistLastSync(episodes);
          if (cfg.compileAfterIngest) {
            engine.requestCompile("ingest-completed");
          } else {
            engine.markDirty();
          }
        }

        if (outcome.cancelled) {
          void vscode.window.showWarningMessage(
            `Statewave (GitHub): cancelled — ${outcome.ingested}/${outcome.attempted} ingested.`,
          );
        } else if (outcome.failed > 0) {
          void vscode.window.showWarningMessage(
            `Statewave (GitHub): ingested ${outcome.ingested}/${outcome.attempted}; ${outcome.failed} failed. See output.`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `Statewave: ingested ${outcome.ingested} GitHub episode(s). Compiling memory in the background.`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`github-sync ingest error: ${msg}`);
        engine.noteError();
        void vscode.window.showErrorMessage(`Statewave GitHub ingest: ${msg}`);
      } finally {
        engine.setPhase("idle");
      }
    },
  );
}

interface RepoRef {
  owner: string;
  name: string;
}

async function resolveRepo(
  root: string,
  override?: string,
): Promise<RepoRef | undefined> {
  if (override) {
    const [owner, name] = override.split("/");
    if (owner && name) return { owner, name };
    return undefined;
  }
  const git = await readGitContext(root);
  if (git.host === "github.com" && git.owner && git.repo) {
    // We split nested groups elsewhere; GitHub doesn't use them, so the
    // primary segment of `owner` is always safe here.
    return { owner: git.owner, name: git.repo };
  }
  return undefined;
}

async function resolveToken(fromSettings?: string): Promise<string | undefined> {
  if (fromSettings) return fromSettings;
  // Prefer VS Code's built-in GitHub auth session — token lives in the OS
  // keychain, never in settings or the repo. Silent first (no prompt),
  // then a single interactive prompt if no existing session.
  try {
    const silent = await vscode.authentication.getSession("github", ["repo"], {
      createIfNone: false,
      silent: true,
    });
    if (silent) return silent.accessToken;
    const session = await vscode.authentication.getSession("github", ["repo"], {
      createIfNone: true,
    });
    return session?.accessToken;
  } catch {
    // Provider unavailable (e.g. Cursor without the GitHub provider).
    return undefined;
  }
}

async function persistLastSync(
  episodes: ReadonlyArray<StatewaveEpisode>,
): Promise<void> {
  let newest: string | undefined;
  for (const ep of episodes) {
    if (!newest || ep.occurred_at > newest) newest = ep.occurred_at;
  }
  if (newest) await engine.wsSet("statewave.github.lastSyncAt", newest);
}
