import * as vscode from "vscode";
import { createGithubConnector } from "@statewavedev/connectors-github";
import { createGitlabConnector } from "@statewavedev/connectors-gitlab";
import { createBitbucketConnector } from "@statewavedev/connectors-bitbucket";
import { createGiteaConnector } from "@statewavedev/connectors-gitea";
import { createAzureDevOpsConnector } from "@statewavedev/connectors-azure-devops";
import {
  CancellationFlag,
  applyRedaction,
  createIngestClient,
  ingestEpisodesParallel,
  readGitContext,
  resolveSubject,
  resolveForgeKind,
  resolveForgeBaseUrl,
  forgeDescriptor,
  parseAzureRemote,
  type ForgeId,
  type StatewaveEpisode,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { engine } from "./engine.js";
import { log, previewEpisodes, reportOutcome } from "./output.js";

/**
 * `Statewave: Sync Project History` — the generalized, forge-agnostic sibling
 * of `Statewave: Sync GitHub Project History`.
 *
 * Auto-detects the forge from the workspace git remote (or an explicit
 * `statewave.forge.kind`/`host`) and pulls issues / merge-requests / PRs /
 * comments / reviews / releases / work-items via the matching
 * `@statewavedev/connectors-<forge>` package, ingesting under the same
 * sanitized workspace subject as the rest of the project memory.
 *
 * Same hard rules as the GitHub path:
 *  - Off by default (`statewave.forge.enabled`).
 *  - Manual only — never on activation / save / watcher loop.
 *  - Preview-first; explicit Ingest click.
 *  - Auth prefers the editor's built-in provider where one exists (GitHub,
 *    Microsoft for Azure DevOps); otherwise a per-forge `statewave.forge.token`
 *    fallback. Tokens never live in the repo.
 */
export async function syncForgeHistory(): Promise<void> {
  const cfg = readConfig();
  if (!cfg.forge.enabled) {
    void vscode.window.showInformationMessage(
      "Statewave: Project History sync is off. Turn on statewave.forge.enabled to use this command.",
    );
    return;
  }

  const folder = primaryWorkspaceFolder();
  if (!folder) {
    void vscode.window.showWarningMessage("Statewave: open a folder first.");
    return;
  }

  const git = await readGitContext(folder.uri.fsPath);

  // 1. Resolve which forge this is (explicit kind → detect from remote host).
  const forge = resolveForgeKind(cfg.forge.kind, cfg.forge.host || git.host);
  if (!forge) {
    void vscode.window.showErrorMessage(
      `Statewave Project History: could not detect the forge from the git remote (${git.host ?? "no remote"}). Set statewave.forge.kind (e.g. gitlab) and, for self-hosted instances, statewave.forge.host.`,
    );
    return;
  }
  const descriptor = forgeDescriptor(forge);

  // 2. Resolve the workspace subject (sanitized — server-safe, host-independent).
  const subject = resolveSubject({
    config: cfg,
    remoteUrl: git.remoteUrl,
    folderName: folder.name,
  });
  if (!subject) {
    void vscode.window.showErrorMessage(
      "Statewave Project History: could not resolve a subject (see statewave.subjectStrategy).",
    );
    return;
  }

  // 3. Resolve the repo spec (override → detect from remote). Azure DevOps
  //    needs organization/project/repository; the rest use owner/name.
  const repoSpec = resolveRepoSpec(forge, git, cfg.forge.repo);
  if (!repoSpec) {
    void vscode.window.showErrorMessage(
      forge === "azure-devops"
        ? "Statewave Project History: set statewave.forge.repo to organization/project/repository (Azure DevOps remotes are not always auto-detectable)."
        : `Statewave Project History: could not resolve owner/name for ${descriptor.displayName} — set statewave.forge.repo, or open a folder with a matching git remote.`,
    );
    return;
  }

  // 4. Resolve the connector base URL (GHES /api/v3, self-managed GitLab/Gitea
  //    origin, …). Gitea/Forgejo are self-hosted only — a base URL is required.
  const baseUrl = resolveForgeBaseUrl({
    forge,
    kind: cfg.forge.kind,
    host: cfg.forge.host || git.host,
    explicitBaseUrl: cfg.forge.baseUrl,
  });
  if (descriptor.baseUrlRequired && !baseUrl) {
    void vscode.window.showErrorMessage(
      `Statewave Project History: ${descriptor.displayName} is self-hosted — set statewave.forge.host (e.g. git.example.com) or statewave.forge.baseUrl.`,
    );
    return;
  }

  // 5. Resolve auth: explicit token → editor auth session → none.
  const token = await resolveForgeToken(forge, cfg.forge.token);

  const since =
    (cfg.forge.since && cfg.forge.since.trim()) ||
    engine.wsGet<string>(cursorKey(forge)) ||
    undefined;

  log(
    `forge-sync: forge=${forge} repo=${repoSpec} subject=${subject} baseUrl=${baseUrl ?? "(default)"} include=${cfg.forge.include?.join(",") || "(connector default)"} since=${since ?? "(none)"} token=${token ? "yes" : "no (public-only)"}`,
  );

  // 6. Fetch via the connector (dry-run; we ingest through our own queue).
  let episodes: ReadonlyArray<StatewaveEpisode>;
  try {
    const conn = buildConnector(forge, { repo: repoSpec, subject, token, baseUrl });
    engine.setPhase("syncing");
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Statewave: pulling ${repoSpec} from ${descriptor.displayName}…`,
        cancellable: false,
      },
      () =>
        conn.sync({
          subject,
          ...(since ? { since } : {}),
          ...(cfg.forge.include && cfg.forge.include.length > 0
            ? { include: cfg.forge.include }
            : {}),
          maxItems: cfg.forge.maxItems,
          dryRun: true,
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
    log(`forge-sync error: ${msg}`);
    void vscode.window.showErrorMessage(`Statewave Project History (${descriptor.displayName}): ${msg}`);
    return;
  }

  engine.setPhase("idle");

  if (episodes.length === 0) {
    void vscode.window.showInformationMessage(
      `Statewave: ${descriptor.displayName} returned 0 new episodes for ${repoSpec}${since ? ` since ${since}` : ""}.`,
    );
    return;
  }

  // 7. Preview + explicit Ingest (mirrors the GitHub path UX).
  previewEpisodes(`${descriptor.displayName} history (${repoSpec})`, subject, episodes);

  if (!cfg.url) {
    void vscode.window.showInformationMessage(
      `Statewave: previewed ${episodes.length} ${descriptor.displayName} episode(s) for ${subject}. Set statewave.url to enable ingestion.`,
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Statewave: previewed ${episodes.length} ${descriptor.displayName} episode(s) for ${subject}. Send them to ${cfg.url}?`,
    { modal: false },
    "Ingest to Statewave",
    "Show Preview",
  );
  if (choice === "Show Preview") {
    void vscode.commands.executeCommand("workbench.action.output.toggleOutput");
    return;
  }
  if (choice !== "Ingest to Statewave") return;

  // 8. Ingest through the existing parallel queue + scheduler.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Statewave: ingesting ${descriptor.displayName} history…`,
      cancellable: true,
    },
    async (progress, cancelToken) => {
      engine.setPhase("syncing");
      const cancel = new CancellationFlag();
      cancelToken.onCancellationRequested(() => cancel.cancel());
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
          await persistLastSync(forge, episodes);
          if (cfg.compileAfterIngest) {
            engine.requestCompile("ingest-completed");
          } else {
            engine.markDirty();
          }
        }

        if (outcome.cancelled) {
          void vscode.window.showWarningMessage(
            `Statewave (${descriptor.displayName}): cancelled — ${outcome.ingested}/${outcome.attempted} ingested.`,
          );
        } else if (outcome.failed > 0) {
          void vscode.window.showWarningMessage(
            `Statewave (${descriptor.displayName}): ingested ${outcome.ingested}/${outcome.attempted}; ${outcome.failed} failed. See output.`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `Statewave: ingested ${outcome.ingested} ${descriptor.displayName} episode(s). Compiling memory in the background.`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`forge-sync ingest error: ${msg}`);
        engine.noteError();
        void vscode.window.showErrorMessage(`Statewave Project History ingest: ${msg}`);
      } finally {
        engine.setPhase("idle");
      }
    },
  );
}

/**
 * Structural shape of every `@statewavedev/connectors-<forge>` connector — we
 * only ever call `sync()` in dry-run and read the mapped episodes back.
 */
interface ForgeConnectorLike {
  sync(options: {
    subject?: string;
    since?: string;
    include?: ReadonlyArray<string>;
    maxItems?: number;
    dryRun?: boolean;
    redaction?: { email: boolean; phone: boolean; secrets: boolean };
  }): Promise<{ episodes: ReadonlyArray<StatewaveEpisode> }>;
}

interface ForgeBuildParams {
  repo: string;
  subject: string;
  token?: string;
  baseUrl?: string;
}

function buildConnector(forge: ForgeId, p: ForgeBuildParams): ForgeConnectorLike {
  const tok = p.token ? { token: p.token } : {};
  const base = p.baseUrl ? { baseUrl: p.baseUrl } : {};
  switch (forge) {
    case "github":
      return createGithubConnector({ repo: p.repo, subject: p.subject, ...tok, ...base });
    case "gitlab":
      return createGitlabConnector({ repo: p.repo, subject: p.subject, ...tok, ...base });
    case "bitbucket":
      return createBitbucketConnector({ repo: p.repo, subject: p.subject, ...tok, ...base });
    case "gitea":
      // baseUrl is required for Gitea/Forgejo; the caller guarantees it is set.
      return createGiteaConnector({ repo: p.repo, subject: p.subject, baseUrl: p.baseUrl ?? "", ...tok });
    case "azure-devops":
      return createAzureDevOpsConnector({ repo: p.repo, subject: p.subject, ...tok, ...base });
    default: {
      const _exhaustive: never = forge;
      throw new Error(`unsupported forge: ${String(_exhaustive)}`);
    }
  }
}

function resolveRepoSpec(
  forge: ForgeId,
  git: { remoteUrl: string | null; owner: string | null; repo: string | null },
  override?: string,
): string | undefined {
  const ov = override?.trim();
  if (ov) return ov;
  if (forge === "azure-devops") {
    const parts = parseAzureRemote(git.remoteUrl);
    return parts ? `${parts.organization}/${parts.project}/${parts.repository}` : undefined;
  }
  if (git.owner && git.repo) return `${git.owner}/${git.repo}`;
  return undefined;
}

/** Per-forge workspace-state key for the incremental `since` cursor. */
function cursorKey(forge: ForgeId): string {
  return `statewave.forge.${forge}.lastSyncAt`;
}

async function resolveForgeToken(forge: ForgeId, fromSettings?: string): Promise<string | undefined> {
  const fixed = fromSettings?.trim();
  if (fixed) return fixed;

  const descriptor = forgeDescriptor(forge);
  if (!descriptor.authProviderId) return undefined;

  // Prefer the editor's built-in auth session — the token lives in the OS
  // keychain, never in settings or the repo. Silent first, then one prompt.
  const scopes = authScopes(forge);
  try {
    const silent = await vscode.authentication.getSession(descriptor.authProviderId, scopes, {
      createIfNone: false,
      silent: true,
    });
    if (silent) return silent.accessToken;
    const session = await vscode.authentication.getSession(descriptor.authProviderId, scopes, {
      createIfNone: true,
    });
    return session?.accessToken;
  } catch {
    // Provider unavailable (e.g. Cursor without the provider) — fall back to
    // public-only reads / the token setting.
    return undefined;
  }
}

function authScopes(forge: ForgeId): string[] {
  if (forge === "github") return ["repo"];
  // Azure DevOps resource scope for the built-in Microsoft auth provider.
  if (forge === "azure-devops") return ["499b84ac-1321-427f-aa17-267ca6975798/.default"];
  return [];
}

async function persistLastSync(
  forge: ForgeId,
  episodes: ReadonlyArray<StatewaveEpisode>,
): Promise<void> {
  let newest: string | undefined;
  for (const ep of episodes) {
    if (!newest || ep.occurred_at > newest) newest = ep.occurred_at;
  }
  if (newest) await engine.wsSet(cursorKey(forge), newest);
}
