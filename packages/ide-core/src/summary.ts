import * as path from "node:path";
import type {
  GitContext,
  ProjectSummary,
  ScannedWorkspaceFile,
  WorkspaceScan,
} from "./types.js";
import { isArchitectureDoc, isDocLike } from "./classify.js";

const LANG_BY_EXT: ReadonlyArray<[RegExp, string]> = [
  [/\.[cm]?tsx?$/i, "TypeScript"],
  [/\.[cm]?jsx?$/i, "JavaScript"],
  [/\.py$/i, "Python"],
  [/\.go$/i, "Go"],
  [/\.rs$/i, "Rust"],
  [/\.rb$/i, "Ruby"],
  [/\.java$/i, "Java"],
  [/\.(?:kt|kts)$/i, "Kotlin"],
  [/\.cs$/i, "C#"],
  [/\.(?:cpp|cc|cxx|hpp)$/i, "C++"],
  [/\.swift$/i, "Swift"],
  [/\.php$/i, "PHP"],
  [/\.(?:sh|bash|zsh)$/i, "Shell"],
];

const CAP = 24;

/**
 * Derive the durable project model from a scan + git context + the resolved
 * subject. Pure and deterministic so the `ide.project.summary` episode has a
 * stable idempotency key as long as the inputs are stable.
 */
export function buildProjectSummary(
  scan: WorkspaceScan,
  git: GitContext,
  subject: string,
): ProjectSummary {
  const toolchain = new Set<string>();
  const languages = new Set<string>();
  const keyDocs: string[] = [];
  const architectureDocs: string[] = [];
  const conventions = new Set<string>();
  let hasTests = false;

  for (const f of scan.files) {
    switch (f.category) {
      case "node-manifest":
        toolchain.add("npm/node");
        break;
      case "workspace-manifest":
        toolchain.add("monorepo");
        conventions.add("monorepo workspace");
        break;
      case "tsconfig":
        toolchain.add("typescript");
        break;
      case "python-manifest":
        toolchain.add("python");
        break;
      case "dockerfile":
        toolchain.add("docker");
        break;
      case "compose":
        toolchain.add("docker-compose");
        break;
      case "test":
        hasTests = true;
        break;
      default:
        break;
    }

    if (isDocLike(f.category)) keyDocs.push(f.relativePath);
    if (isArchitectureDoc(f.category)) architectureDocs.push(f.relativePath);

    for (const [re, lang] of LANG_BY_EXT) {
      if (re.test(f.relativePath)) {
        languages.add(lang);
        break;
      }
    }
  }

  if (scan.files.some((f) => f.relativePath === "pnpm-workspace.yaml")) {
    toolchain.add("pnpm");
  }
  if (scan.files.some((f) => f.relativePath === "pyproject.toml")) {
    toolchain.add("poetry/pyproject");
  }
  if (architectureDocs.length > 0) conventions.add("documents architecture decisions (ADR/RFC)");
  if (hasTests) conventions.add("has an automated test suite");
  if (git.branch && git.branch !== "main" && git.branch !== "master") {
    conventions.add(`active work on branch \`${git.branch}\``);
  }

  const layout = topLevelDirs(scan.files);

  return {
    name: deriveName(scan, git, subject),
    subject,
    branch: git.branch,
    remoteUrl: git.remoteUrl,
    toolchain: [...toolchain].sort(),
    languages: [...languages].sort(),
    layout,
    keyDocs: keyDocs.slice(0, CAP),
    architectureDocs: architectureDocs.slice(0, CAP),
    conventions: [...conventions],
    hasTests,
    fileCount: scan.files.length,
  };
}

function deriveName(scan: WorkspaceScan, git: GitContext, subject: string): string {
  if (git.repo) return git.repo;
  if (subject.startsWith("repo:")) return subject.slice(5);
  if (subject.startsWith("workspace:")) return subject.slice(10);
  return scan.folderName;
}

function topLevelDirs(files: ReadonlyArray<ScannedWorkspaceFile>): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const top = f.relativePath.split("/")[0];
    if (top && top !== f.relativePath) dirs.add(top);
  }
  return [...dirs].sort().slice(0, CAP);
}

/**
 * Human-readable rendering for the `ide.project.summary` episode text. Kept
 * compact and self-contained — a memory compiler should be able to summarise
 * the project from this alone, without re-reading the repo.
 */
export function renderProjectSummaryText(summary: ProjectSummary): string {
  const lines: string[] = [];
  lines.push(`# Project: ${summary.name}`);
  lines.push("");
  lines.push(`Subject: ${summary.subject}`);
  if (summary.remoteUrl) lines.push(`Remote: ${summary.remoteUrl}`);
  if (summary.branch) lines.push(`Branch: ${summary.branch}`);
  lines.push(`Files indexed: ${summary.fileCount}`);
  lines.push("");
  if (summary.languages.length > 0) {
    lines.push(`Languages: ${summary.languages.join(", ")}`);
  }
  if (summary.toolchain.length > 0) {
    lines.push(`Toolchain: ${summary.toolchain.join(", ")}`);
  }
  if (summary.layout.length > 0) {
    lines.push(`Top-level layout: ${summary.layout.join(", ")}`);
  }
  if (summary.conventions.length > 0) {
    lines.push("");
    lines.push("Conventions:");
    for (const c of summary.conventions) lines.push(`- ${c}`);
  }
  if (summary.architectureDocs.length > 0) {
    lines.push("");
    lines.push("Architecture / decision docs:");
    for (const d of summary.architectureDocs) lines.push(`- ${d}`);
  }
  if (summary.keyDocs.length > 0) {
    lines.push("");
    lines.push("Key documentation:");
    for (const d of summary.keyDocs) lines.push(`- ${d}`);
  }
  return lines.join("\n");
}

/** Stable basename helper reused by episode mappers. */
export function fileTitle(relativePath: string): string {
  return path.basename(relativePath);
}
