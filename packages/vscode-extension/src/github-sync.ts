import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
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
  /** Where the .git that named this repo lives (informational). */
  root?: string;
}

/**
 * Detect the GitHub repo to sync.
 *
 * Ladder (first match wins):
 *  1. Explicit `statewave.github.repo` override.
 *  2. Workspace root is itself a github.com repo.
 *  3. The active editor's enclosing repo, if it's under the workspace root.
 *  4. Any additional VS Code multi-root folder that is a github.com repo.
 *  5. One-level scan under the workspace root for sibling github.com repos
 *     ("umbrella" pattern — a folder containing several sibling clones).
 *
 * Multiple → QuickPick + offer to remember the choice as a workspace
 * setting so the next run is silent. Single → use silently.
 */
async function resolveRepo(
  rootCandidate: string,
  override?: string,
): Promise<RepoRef | undefined> {
  if (override) {
    const [owner, name] = override.split("/");
    if (owner && name) return { owner, name };
    return undefined;
  }

  const root = await readRepoFor(rootCandidate);
  if (root) return root;

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === "file") {
    const enc = await findEnclosingRepo(path.dirname(active.fsPath));
    if (enc?.root?.startsWith(rootCandidate)) return enc;
  }

  const candidates = new Map<string, RepoRef>();
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.fsPath === rootCandidate) continue;
    const r = await readRepoFor(f.uri.fsPath);
    if (r) candidates.set(`${r.owner}/${r.name}`, r);
  }
  if (candidates.size === 0) {
    for (const r of await scanSubdirRepos(rootCandidate)) {
      candidates.set(`${r.owner}/${r.name}`, r);
    }
  }

  const list = [...candidates.values()].sort((a, b) =>
    `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`),
  );
  if (list.length === 0) return undefined;
  if (list.length === 1) {
    log(`github-sync: auto-detected ${list[0]!.owner}/${list[0]!.name} (${list[0]!.root ?? "?"})`);
    return list[0];
  }

  type Item = vscode.QuickPickItem & { repo?: RepoRef };
  const items: Item[] = list.map((r) => ({
    label: `$(github) ${r.owner}/${r.name}`,
    description: r.root ? path.basename(r.root) : "",
    repo: r,
  }));
  const pick = (await vscode.window.showQuickPick(items, {
    title: "Statewave GitHub sync",
    placeHolder:
      "Multiple github.com repos under this workspace — pick one to sync",
  })) as Item | undefined;
  if (!pick?.repo) return undefined;

  const remember = await vscode.window.showInformationMessage(
    `Use ${pick.repo.owner}/${pick.repo.name} for GitHub sync in this workspace from now on?`,
    "Yes — remember",
    "Just this time",
  );
  if (remember === "Yes — remember") {
    try {
      await vscode.workspace
        .getConfiguration("statewave.github")
        .update(
          "repo",
          `${pick.repo.owner}/${pick.repo.name}`,
          vscode.ConfigurationTarget.Workspace,
        );
      log(
        `github-sync: saved statewave.github.repo=${pick.repo.owner}/${pick.repo.name} (workspace)`,
      );
    } catch (err) {
      log(`github-sync: could not persist override: ${(err as Error).message}`);
    }
  }
  return pick.repo;
}

async function readRepoFor(root: string): Promise<RepoRef | undefined> {
  const g = await readGitContext(root);
  if (g.host === "github.com" && g.owner && g.repo) {
    return { owner: g.owner, name: g.repo, root };
  }
  return undefined;
}

async function hasGitMarker(dir: string): Promise<boolean> {
  try {
    const s = await fs.stat(path.join(dir, ".git"));
    return s.isDirectory() || s.isFile(); // file = worktree pointer
  } catch {
    return false;
  }
}

/** Walk up from `start` to find the first enclosing git repo (github.com only). */
async function findEnclosingRepo(start: string): Promise<RepoRef | undefined> {
  let dir = start;
  while (true) {
    if (await hasGitMarker(dir)) return readRepoFor(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const SCAN_SKIP = new Set([
  "node_modules", ".git", ".hg", "dist", "build", "out", "coverage",
  ".turbo", ".cache", ".venv", "venv", "__pycache__", ".idea", ".vscode",
  ".pytest_cache", ".ruff_cache", "target", "vendor",
]);

/** One-level scan: any immediate sub-folder that's a github.com repo. */
async function scanSubdirRepos(root: string): Promise<RepoRef[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RepoRef[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SCAN_SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const sub = path.join(root, e.name);
    if (await hasGitMarker(sub)) {
      const r = await readRepoFor(sub);
      if (r) out.push(r);
    }
  }
  return out;
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
