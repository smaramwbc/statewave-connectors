/**
 * Forge detection + metadata, editor-independent.
 *
 * The IDE Companion can pull project history from several git forges (GitHub,
 * GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps). The *connector* for each
 * forge lives in its own `@statewavedev/connectors-<forge>` package; this
 * module only answers the editor-side questions: "given a git remote host,
 * which forge is this?" and "what's the API base URL / auth provider?". It is
 * pure and unit-testable — nothing here imports `vscode` or a connector.
 *
 * Auto-detection covers the well-known public hosts. Self-managed instances
 * (GitHub Enterprise Server, self-hosted GitLab/Gitea, Azure DevOps Server)
 * are resolved from an explicit `kind` + `host` the user configures, because
 * their hostnames are arbitrary.
 */

/** A forge the IDE Companion can sync history from. Maps 1:1 to a connector package. */
export type ForgeId = "github" | "gitlab" | "bitbucket" | "gitea" | "azure-devops";

/**
 * The user-facing `kind` selector. `auto` detects from the git remote;
 * `github-enterprise` is GitHub Enterprise Server — the same connector as
 * `github` but pointed at a custom `host`/`baseUrl`.
 */
export type ForgeKind = "auto" | ForgeId | "github-enterprise";

export interface ForgeDescriptor {
  id: ForgeId;
  displayName: string;
  /** Hosts that unambiguously identify this forge. */
  knownHosts: ReadonlyArray<string>;
  /** Substrings that strongly hint at this forge in a self-managed hostname. */
  hostHints: ReadonlyArray<string>;
  /** VS Code authentication provider id, when the editor ships one. */
  authProviderId?: string;
  /** Whether a base URL is mandatory (self-hosted-only forges). */
  baseUrlRequired: boolean;
}

export const FORGES: ReadonlyArray<ForgeDescriptor> = [
  {
    id: "github",
    displayName: "GitHub",
    knownHosts: ["github.com"],
    hostHints: ["github"],
    authProviderId: "github",
    baseUrlRequired: false,
  },
  {
    id: "gitlab",
    displayName: "GitLab",
    knownHosts: ["gitlab.com"],
    hostHints: ["gitlab"],
    baseUrlRequired: false,
  },
  {
    id: "bitbucket",
    displayName: "Bitbucket",
    knownHosts: ["bitbucket.org"],
    hostHints: ["bitbucket"],
    baseUrlRequired: false,
  },
  {
    id: "gitea",
    displayName: "Gitea / Forgejo",
    // codeberg.org is a public Forgejo instance — the most common "just works" host.
    knownHosts: ["codeberg.org"],
    hostHints: ["gitea", "forgejo", "codeberg"],
    baseUrlRequired: true,
  },
  {
    id: "azure-devops",
    displayName: "Azure DevOps",
    knownHosts: ["dev.azure.com", "ssh.dev.azure.com"],
    hostHints: ["visualstudio.com", "azure"],
    authProviderId: "microsoft",
    baseUrlRequired: false,
  },
];

export function forgeDescriptor(id: ForgeId): ForgeDescriptor {
  const d = FORGES.find((f) => f.id === id);
  // Every ForgeId has an entry; the assertion documents that invariant.
  if (!d) throw new Error(`unknown forge: ${id}`);
  return d;
}

/**
 * Detect the forge from a git remote host (e.g. `gitlab.com`,
 * `git.example.com`). Returns null when no known forge matches — the caller
 * then asks the user to set `kind`/`host` explicitly.
 *
 * Matching is: exact known host → host-hint substring. Azure's
 * `*.visualstudio.com` legacy hosts are covered by the hint.
 */
export function detectForgeFromHost(host: string | null | undefined): ForgeId | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  if (!h) return null;

  for (const forge of FORGES) {
    if (forge.knownHosts.includes(h)) return forge.id;
  }
  // visualstudio.com appears as `<org>.visualstudio.com`.
  if (h === "dev.azure.com" || h === "ssh.dev.azure.com" || h.endsWith(".visualstudio.com")) {
    return "azure-devops";
  }
  for (const forge of FORGES) {
    if (forge.hostHints.some((hint) => h.includes(hint))) return forge.id;
  }
  return null;
}

/**
 * Resolve a user `kind` selector + optional host into a concrete forge id.
 *
 *   - `auto`              → detect from the remote host
 *   - `github-enterprise` → `github` (the connector is the same; the host/baseUrl differ)
 *   - any explicit id     → that id
 *
 * Returns null only for `auto` with an undetectable host.
 */
export function resolveForgeKind(kind: ForgeKind, remoteHost: string | null | undefined): ForgeId | null {
  if (kind === "auto") return detectForgeFromHost(remoteHost);
  if (kind === "github-enterprise") return "github";
  return kind;
}

export interface ForgeApiTarget {
  /** The connector `baseUrl`, or undefined to use the connector's public default. */
  baseUrl?: string;
}

/**
 * Compute the connector `baseUrl` for a forge.
 *
 *   - explicit `baseUrl` wins verbatim.
 *   - GitHub Enterprise Server: `https://<host>/api/v3` (the documented GHES API root).
 *   - self-managed GitLab / Gitea: `https://<host>` (the connectors append their own `/api/...`).
 *   - public hosts: undefined (connector default).
 */
export function resolveForgeBaseUrl(input: {
  forge: ForgeId;
  kind: ForgeKind;
  host?: string | null;
  explicitBaseUrl?: string | null;
}): string | undefined {
  const explicit = input.explicitBaseUrl?.trim();
  if (explicit) return explicit;

  const host = input.host?.trim();
  if (!host) return undefined;
  const origin = host.startsWith("http://") || host.startsWith("https://") ? host : `https://${host}`;

  if (input.kind === "github-enterprise") {
    return `${origin.replace(/\/+$/, "")}/api/v3`;
  }
  // gitlab (self-managed) and gitea/forgejo take the bare origin; the connector
  // appends /api/v4 and /api/v1 respectively. Public hosts pass host === "" and
  // never reach here.
  if (input.forge === "gitlab" || input.forge === "gitea") {
    return origin.replace(/\/+$/, "");
  }
  return undefined;
}

export interface AzureRepoParts {
  organization: string;
  project: string;
  repository: string;
}

/**
 * Best-effort parse of an Azure DevOps git remote into org/project/repo.
 *
 * Handles the common shapes:
 *   - https://dev.azure.com/{org}/{project}/_git/{repo}
 *   - https://{org}@dev.azure.com/{org}/{project}/_git/{repo}
 *   - https://{org}.visualstudio.com/{project}/_git/{repo}     (legacy, org in host)
 *   - git@ssh.dev.azure.com:v3/{org}/{project}/{repo}          (scp-like)
 *
 * Returns null when the URL doesn't yield all three parts — the caller falls
 * back to the explicit `statewave.forge.repo` override.
 */
export function parseAzureRemote(url: string | null | undefined): AzureRepoParts | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // scp-like: git@ssh.dev.azure.com:v3/org/project/repo
  const scp = trimmed.match(/^[^@]+@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (scp) {
    return { organization: scp[1]!, project: decodeURIComponent(scp[2]!), repository: trimEnd(scp[3]!) };
  }

  let host: string;
  let p: string;
  const m = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (!m) return null;
  host = m[1]!.toLowerCase().replace(/:\d+$/, "");
  p = m[2]!.replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = p.split("/").filter(Boolean);

  // Legacy: {org}.visualstudio.com/{project}/_git/{repo}
  if (host.endsWith(".visualstudio.com")) {
    const org = host.slice(0, -".visualstudio.com".length);
    const gitIdx = parts.indexOf("_git");
    if (org && gitIdx >= 1 && parts[gitIdx + 1]) {
      return {
        organization: org,
        project: decodeURIComponent(parts.slice(0, gitIdx).join("/")),
        repository: trimEnd(parts[gitIdx + 1]!),
      };
    }
    return null;
  }

  // dev.azure.com/{org}/{project}/_git/{repo}
  if (host === "dev.azure.com") {
    const gitIdx = parts.indexOf("_git");
    if (gitIdx >= 2 && parts[gitIdx + 1]) {
      return {
        organization: parts[0]!,
        project: decodeURIComponent(parts.slice(1, gitIdx).join("/")),
        repository: trimEnd(parts[gitIdx + 1]!),
      };
    }
  }
  return null;
}

function trimEnd(repo: string): string {
  const r = repo.replace(/\/+$/, "");
  return r.toLowerCase().endsWith(".git") ? r.slice(0, -4) : r;
}
