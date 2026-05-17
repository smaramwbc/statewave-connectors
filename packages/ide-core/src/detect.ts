/**
 * Decide which assistant clients are actually present, so the plugin only
 * writes a client's instruction file when that client is real here.
 *
 * Same principle the MCP wiring already follows ("only act if installed") —
 * applied to the in-repo instruction files too, so a plain-VS-Code user
 * never gets `.cursor/`, `.windsurf/`, `.roo/`, … rule files for editors
 * they don't run.
 *
 * Pure: the editor host gathers the raw signals; this maps them to clients
 * so the decision is unit-testable.
 */

export type EditorKind = "vscode" | "cursor" | "windsurf" | "other";

export interface ClientSignals {
  /** Which editor the extension host is running in. */
  editor: EditorKind;
  /** GitHub Copilot (Chat) extension installed in the host. */
  hasCopilot: boolean;
  /** Claude Code present (extension installed, or ~/.claude.json exists). */
  hasClaudeCode: boolean;
  /** Cline extension installed in the host. */
  hasCline: boolean;
  /** Roo Code extension installed in the host. */
  hasRoo: boolean;
  /** Continue present (extension installed, or ~/.continue exists). */
  hasContinue: boolean;
}

/**
 * Map signals → the set of client ids whose instruction file is worth
 * writing. `cursor`/`windsurf` are *editor-native* (their rules file only
 * helps when you actually run that editor); the rest are extensions/CLIs
 * that can live inside any VS Code-family host.
 */
export function resolveActiveClients(
  signals: ClientSignals,
): ReadonlyArray<string> {
  const active: string[] = [];
  if (signals.hasCopilot) active.push("copilot");
  if (signals.editor === "cursor") active.push("cursor");
  if (signals.editor === "windsurf") active.push("windsurf");
  if (signals.hasClaudeCode) active.push("claude");
  if (signals.hasCline) active.push("cline");
  if (signals.hasRoo) active.push("roo");
  if (signals.hasContinue) active.push("continue");
  return active;
}

/** Classify the editor from its uri scheme (preferred) or app name. */
export function editorKind(uriScheme: string, appName: string): EditorKind {
  const s = uriScheme.toLowerCase();
  const a = appName.toLowerCase();
  if (s === "cursor" || a.includes("cursor")) return "cursor";
  if (s === "windsurf" || a.includes("windsurf")) return "windsurf";
  if (s.startsWith("vscode") || a.includes("visual studio code") || a.includes("vscodium")) {
    return "vscode";
  }
  return "other";
}
