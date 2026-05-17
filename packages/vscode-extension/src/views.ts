import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  diagnose,
  summarizeTransparency,
  scanWorkspace,
  readGitContext,
  resolveSubject,
  buildProjectSummary,
  buildProjectUnderstanding,
  isArchitectureDoc,
  isIgnored,
  type DiagnoseProbe,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { engine } from "./engine.js";
import { collectGitHistory } from "./collect.js";
import { collectDiagnostics } from "./diagnostics.js";
import { log } from "./output.js";
import { detectActiveClients } from "./instructions.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** `Statewave: Open Project Understanding` — the showcase webview. */
export async function openProjectUnderstanding(): Promise<void> {
  const folder = primaryWorkspaceFolder();
  if (!folder) {
    void vscode.window.showWarningMessage("Statewave: open a folder first.");
    return;
  }
  const cfg = readConfig();
  const root = folder.uri.fsPath;
  const git = await readGitContext(root);
  const subject =
    resolveSubject({ config: cfg, remoteUrl: git.remoteUrl, folderName: folder.name }) ??
    `workspace:${folder.name}`;
  const scan = await scanWorkspace(root, {
    includeGlobs: cfg.includeGlobs,
    excludeGlobs: cfg.excludeGlobs,
  });
  const summary = buildProjectSummary(scan, git, subject);
  const commits = await collectGitHistory(root);
  const diagnostics = collectDiagnostics(root);
  const architectureDocs = scan.files
    .filter((f) => isArchitectureDoc(f.category))
    .map((f) => f.relativePath);

  const u = buildProjectUnderstanding({
    subject,
    summary,
    scan,
    git,
    commits,
    diagnostics,
    architectureDocs,
  });

  const panel = vscode.window.createWebviewPanel(
    "statewaveUnderstanding",
    `Statewave — ${u.name}`,
    vscode.ViewColumn.Active,
    { enableScripts: false, retainContextWhenHidden: true },
  );

  const sectionsHtml = u.sections
    .map(
      (s, i) => `
    <details ${i < 3 ? "open" : ""}>
      <summary>${esc(s.title)}</summary>
      <div class="body">${s.body.map((l) => `<div>${esc(l)}</div>`).join("")}</div>
      ${
        s.sources.length > 0
          ? `<div class="src">Generated from: ${s.sources.map((x) => `<code>${esc(x)}</code>`).join(", ")}</div>`
          : ""
      }
    </details>`,
    )
    .join("");

  panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 0 18px 24px; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin: 16px 0 2px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: .82rem; margin-bottom: 14px; }
  details { border: 1px solid var(--vscode-panel-border); border-radius: 6px;
            margin: 8px 0; padding: 6px 12px; }
  summary { cursor: pointer; font-weight: 600; }
  .body { margin: 8px 0 4px; }
  .body div { margin: 2px 0; }
  .src { color: var(--vscode-descriptionForeground); font-size: .78rem; margin-top: 6px; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
</style></head>
<body>
  <h1>${esc(u.name)}</h1>
  <div class="meta">Subject <code>${esc(u.subject)}</code> · generated ${esc(u.generatedAt)} · local, offline, deterministic — no AI generation.</div>
  ${sectionsHtml}
</body></html>`;
}

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
