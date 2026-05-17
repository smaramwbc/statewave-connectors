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
  };
}

function isStrategy(v: string): v is SubjectStrategy {
  return v === "auto" || v === "repo" || v === "workspace" || v === "custom";
}

/** The primary workspace folder, or undefined when no folder is open. */
export function primaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}
