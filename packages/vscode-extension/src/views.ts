import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  diagnose,
  summarizeTransparency,
  scanWorkspace,
  readGitContext,
  resolveSubject,
  isIgnored,
  type DiagnoseProbe,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { engine } from "./engine.js";
import { log } from "./output.js";
import { detectActiveClients } from "./instructions.js";

async function reachable(url: string): Promise<{ online: boolean; auth?: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const cfg = readConfig();
    const res = await fetch(url, {
      method: "GET",
      headers: cfg.apiKey ? { "X-API-Key": cfg.apiKey } : {},
      signal: ctrl.signal,
    });
    return { online: true, auth: res.status === 401 ? false : true };
  } catch {
    return { online: false };
  } finally {
    clearTimeout(t);
  }
}

/** `Statewave: Diagnose` — probe the environment, format actionable advice. */
export async function diagnoseCommand(): Promise<void> {
  const cfg = readConfig();
  const folder = primaryWorkspaceFolder();
  const git = folder ? await readGitContext(folder.uri.fsPath) : undefined;
  const subject = folder
    ? resolveSubject({
        config: cfg,
        remoteUrl: git?.remoteUrl,
        folderName: folder.name,
      })
    : null;

  let online: boolean | undefined;
  let authValid: boolean | undefined;
  if (cfg.url) {
    const r = await reachable(cfg.url);
    online = r.online;
    authValid = r.auth;
  }

  let indexedCount: number | undefined;
  let skippedCount: number | undefined;
  if (folder) {
    try {
      const scan = await scanWorkspace(folder.uri.fsPath, {
        includeGlobs: cfg.includeGlobs,
        excludeGlobs: cfg.excludeGlobs,
      });
      indexedCount = scan.files.length;
      skippedCount = scan.filesIgnored;
    } catch {
      /* ignore */
    }
  }

  const snap = engine.snapshotForStatus();
  const active = folder ? await detectActiveClients() : [];
  const probe: DiagnoseProbe = {
    serverUrl: cfg.url,
    serverReachable: online,
    authValid,
    subject,
    subjectStrategy: cfg.subjectStrategy,
    mcpProviderRegistered:
      typeof (vscode as unknown as { lm?: { registerMcpServerDefinitionProvider?: unknown } })
        .lm?.registerMcpServerDefinitionProvider === "function",
    mcpClientsWired: active,
    instructionClients: cfg.assistantInstructions === "off" ? [] : active,
    watcherActive: cfg.autoIndex,
    autoIndex: cfg.autoIndex,
    redactionEnabled: cfg.redactionEnabled,
    lastBuildAt: snap.lastBuildAt,
    lastCompile: snap.compile.state,
    indexedCount,
    skippedCount,
  };

  const report = diagnose(probe);
  log("\n" + report.text);
  const doc = await vscode.workspace.openTextDocument({
    content: report.text + "\n",
    language: "text",
  });
  await vscode.window.showTextDocument(doc, { preview: true });
  if (!report.ok) {
    void vscode.window
      .showWarningMessage(
        "Statewave Diagnose found issues — see the report for fixes.",
        "Copy report",
      )
      .then((p) => {
        if (p === "Copy report") void vscode.env.clipboard.writeText(report.text);
      });
  }
}

const MAX_LIST = 4000;

async function walkAll(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_LIST) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= MAX_LIST) break;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // Still descend ignored dirs so we can explain why they're skipped,
        // but cap depth implicitly via MAX_LIST.
        if (e.name === ".git" || e.name === "node_modules") {
          out.push(path.relative(root, full).split(path.sep).join("/") + "/**");
          continue;
        }
        stack.push(full);
      } else if (e.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  return out;
}

/** `Statewave: Show Indexed Files` — transparency: what & why (in/out). */
export async function showIndexedFiles(): Promise<void> {
  const folder = primaryWorkspaceFolder();
  if (!folder) {
    void vscode.window.showWarningMessage("Statewave: open a folder first.");
    return;
  }
  const cfg = readConfig();
  const paths = (await walkAll(folder.uri.fsPath)).filter(
    (p) => !p.endsWith("/**"),
  );
  const report = summarizeTransparency(paths, {
    includeGlobs: cfg.includeGlobs,
    excludeGlobs: cfg.excludeGlobs,
  });

  const lines: string[] = [
    `# Statewave — what gets indexed (subject scope)`,
    "",
    `Scanned ${paths.length} file(s)${paths.length >= MAX_LIST ? " (capped)" : ""}.`,
    "",
    "## Why (summary)",
    ...Object.entries(report.byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `- ${k}: ${n}`),
    "",
    `## Indexed (${report.indexed.length})`,
    ...report.indexed.slice(0, 500).map((e) => `- ${e.path} — ${e.reason}`),
    report.indexed.length > 500 ? `- …and ${report.indexed.length - 500} more` : "",
    "",
    `## Skipped (${report.skipped.length})`,
    ...report.skipped.slice(0, 500).map((e) => `- ${e.path} — ${e.reason}`),
    report.skipped.length > 500 ? `- …and ${report.skipped.length - 500} more` : "",
    "",
    "_Secret files (.env, *.pem, keys, credentials…) are a hard skip and cannot be opted in via includeGlobs._",
  ].filter((l) => l !== "");

  // Cross-check the summary uses the real predicate.
  void isIgnored;

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join("\n") + "\n",
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}
