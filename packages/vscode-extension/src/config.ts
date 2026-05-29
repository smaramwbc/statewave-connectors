import * as vscode from "vscode";
import type { IdeCompanionConfig, SubjectStrategy } from "@statewavedev/ide-core";

/**
 * Read `statewave.*` settings into the editor-independent
 * `IdeCompanionConfig`. Everything interesting lives in `@statewavedev/ide-core`;
 * this is the only place that touches `vscode.workspace.getConfiguration`.
 *
 * `statewave.subject` (when non-empty) overrides the strategy entirely and is
 * mapped to the `custom` strategy so `resolveSubject` handles it uniformly.
 */
export function readConfig(): IdeCompanionConfig {
  const c = vscode.workspace.getConfiguration("statewave");

  const explicitSubject = (c.get<string>("subject") ?? "").trim();
  const rawStrategy = c.get<string>("subjectStrategy") ?? "auto";
  const strategy: SubjectStrategy = explicitSubject
    ? "custom"
    : isStrategy(rawStrategy)
      ? rawStrategy
      : "auto";

  return {
    url: (c.get<string>("url") ?? "").trim() || undefined,
    apiKey: (c.get<string>("apiKey") ?? "").trim() || undefined,
    subjectStrategy: strategy,
    customSubject: explicitSubject || undefined,
    autoIndex: c.get<boolean>("autoIndex") ?? false,
    includeGlobs: c.get<string[]>("includeGlobs") ?? [],
    excludeGlobs: c.get<string[]>("excludeGlobs") ?? [],
    redactionEnabled: c.get<boolean>("redaction.enabled") ?? true,
    compileAfterIngest: c.get<boolean>("compileAfterIngest") ?? true,
    mcpAutoWire: c.get<boolean>("mcp.autoWire") ?? true,
    mcpClients: c.get<string[]>("mcp.clients") ?? [
      "copilot",
      "cursor",
      "windsurf",
      "claude",
      "cline",
      "roo",
      "continue",
      "codex",
    ],
    assistantInstructions: instructionMode(c.get<string>("assistantInstructions")),
    github: {
      enabled: c.get<boolean>("github.enabled") ?? false,
      repo: (c.get<string>("github.repo") ?? "").trim() || undefined,
      token: (c.get<string>("github.token") ?? "").trim() || undefined,
      include: githubInclude(c.get<string[]>("github.include")),
      since: (c.get<string>("github.since") ?? "").trim() || undefined,
      maxItems: clampInt(c.get<number>("github.maxItems"), 1, 5000, 500),
    },
    forge: {
      enabled: c.get<boolean>("forge.enabled") ?? false,
      kind: forgeKind(c.get<string>("forge.kind")),
      host: (c.get<string>("forge.host") ?? "").trim() || undefined,
      baseUrl: (c.get<string>("forge.baseUrl") ?? "").trim() || undefined,
      repo: (c.get<string>("forge.repo") ?? "").trim() || undefined,
      token: (c.get<string>("forge.token") ?? "").trim() || undefined,
      include: forgeInclude(c.get<string[]>("forge.include")),
      since: (c.get<string>("forge.since") ?? "").trim() || undefined,
      maxItems: clampInt(c.get<number>("forge.maxItems"), 1, 5000, 500),
    },
  };
}

const FORGE_KINDS = [
  "auto",
  "github",
  "gitlab",
  "bitbucket",
  "gitea",
  "github-enterprise",
  "azure-devops",
] as const;
type ForgeKindLiteral = (typeof FORGE_KINDS)[number];

function forgeKind(v: string | undefined): ForgeKindLiteral {
  return (FORGE_KINDS as ReadonlyArray<string>).includes(v ?? "")
    ? (v as ForgeKindLiteral)
    : "auto";
}

/**
 * Forge include groups are forge-specific (GitLab `mrs`/`approvals`, Azure
 * `workitems`, …), so we don't enumerate them here — an empty/undefined list
 * means "use the connector's full default set". We only drop blanks.
 */
function forgeInclude(v: string[] | undefined): ReadonlyArray<string> | undefined {
  if (!v) return undefined;
  const cleaned = v.map((x) => x.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

const GH_KINDS = ["issues", "prs", "comments", "reviews", "releases"] as const;
type GhKind = (typeof GH_KINDS)[number];

function githubInclude(v: string[] | undefined): ReadonlyArray<GhKind> {
  const fallback: ReadonlyArray<GhKind> = GH_KINDS;
  if (!v) return fallback;
  const filtered = v.filter((x): x is GhKind =>
    (GH_KINDS as ReadonlyArray<string>).includes(x),
  );
  return filtered.length > 0 ? filtered : fallback;
}

function clampInt(v: number | undefined, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(lo, Math.min(hi, n));
}

function instructionMode(
  v: string | undefined,
): IdeCompanionConfig["assistantInstructions"] {
  return v === "read-only" || v === "off" ? v : "read-write";
}

function isStrategy(v: string): v is SubjectStrategy {
  return v === "auto" || v === "repo" || v === "workspace" || v === "custom";
}

/** The primary workspace folder, or undefined when no folder is open. */
export function primaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}
