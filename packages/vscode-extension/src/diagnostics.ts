import * as vscode from "vscode";
import * as path from "node:path";
import type { DiagnosticRecord } from "@statewavedev/ide-core";

const SEVERITY: Record<number, DiagnosticRecord["severity"]> = {
  [vscode.DiagnosticSeverity.Error]: "error",
  [vscode.DiagnosticSeverity.Warning]: "warning",
  [vscode.DiagnosticSeverity.Information]: "info",
  [vscode.DiagnosticSeverity.Hint]: "hint",
};

/**
 * Collect the editor's current diagnostics for files inside `root`, flattened
 * to the editor-independent `DiagnosticRecord`. **No source code is read** —
 * only the diagnostic message, code, severity, and location. Messages are
 * redacted downstream (in ide-core) when redaction is enabled.
 */
export function collectDiagnostics(root: string): DiagnosticRecord[] {
  const out: DiagnosticRecord[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") continue;
    const abs = uri.fsPath;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (rel.startsWith("..")) continue; // outside the workspace folder
    for (const d of diags) {
      out.push({
        relativePath: rel,
        severity: SEVERITY[d.severity] ?? "info",
        code: codeToString(d.code),
        message: d.message,
        source: d.source,
        line: d.range.start.line + 1,
      });
    }
  }
  return out;
}

function codeToString(
  code: vscode.Diagnostic["code"],
): string | undefined {
  if (code === undefined || code === null) return undefined;
  if (typeof code === "string" || typeof code === "number") return String(code);
  // { value, target } shape
  return String(code.value);
}
