/**
 * Structured "project understanding" model — the showcase view. Pure: it
 * assembles a sectioned summary (with provenance) from the same inputs we
 * ingest, so it is deterministic, offline-capable, and unit-tested. The
 * extension renders this into a webview; no HTML lives here.
 */
import type {
  ProjectSummary,
  ScannedWorkspaceFile,
  GitContext,
  DiagnosticRecord,
} from "./types.js";
import type { GitCommit } from "./enrich.js";

export interface UnderstandingSection {
  id: string;
  title: string;
  /** Body lines (plain text; renderer escapes). Empty → section hidden. */
  body: string[];
  /** Provenance — concrete files/sources this section was derived from. */
  sources: string[];
}

export interface ProjectUnderstanding {
  subject: string;
  name: string;
  generatedAt: string;
  sections: UnderstandingSection[];
}

export interface UnderstandingInput {
  subject: string;
  summary: ProjectSummary;
  scan: { files: ReadonlyArray<ScannedWorkspaceFile>; folderName: string };
  git: GitContext;
  commits: ReadonlyArray<GitCommit>;
  diagnostics: ReadonlyArray<DiagnosticRecord>;
  /** ADR/RFC/decision relative paths. */
  architectureDocs: ReadonlyArray<string>;
  now?: string;
}

function has(files: ReadonlyArray<ScannedWorkspaceFile>, pred: (p: string) => boolean): string[] {
  return files.filter((f) => pred(f.relativePath.toLowerCase())).map((f) => f.relativePath);
}

export function buildProjectUnderstanding(
  input: UnderstandingInput,
): ProjectUnderstanding {
  const { summary, scan, git, commits, diagnostics } = input;
  const files = scan.files;
  const sections: UnderstandingSection[] = [];

  const push = (
    id: string,
    title: string,
    body: string[],
    sources: string[],
  ): void => {
    const b = body.filter((l) => l && l.trim().length > 0);
    if (b.length > 0) sections.push({ id, title, body: b, sources: [...new Set(sources)] });
  };

  push(
    "overview",
    "Overview",
    [
      `${summary.name} — ${git.branch ? `branch \`${git.branch}\`` : "no branch"}${git.remoteUrl ? `, ${git.remoteUrl}` : ""}.`,
      `${summary.fileCount} files indexed.`,
      summary.conventions.length > 0 ? `Conventions: ${summary.conventions.join("; ")}.` : "",
    ],
    ["git", ...has(files, (p) => p === "readme.md")],
  );

  push(
    "stack",
    "Stack & toolchain",
    [
      summary.languages.length > 0 ? `Languages: ${summary.languages.join(", ")}.` : "",
      summary.toolchain.length > 0 ? `Toolchain: ${summary.toolchain.join(", ")}.` : "",
    ],
    has(files, (p) => /(?:^|\/)(package\.json|pnpm-workspace\.yaml|pyproject\.toml|tsconfig.*\.json|go\.mod|cargo\.toml)$/.test(p)),
  );

  push(
    "layout",
    "Project structure",
    summary.layout.map((d) => `- ${d}/`),
    has(files, (p) => /(?:^|\/)(package\.json|pnpm-workspace\.yaml|lerna\.json|nx\.json|turbo\.json)$/.test(p)),
  );

  const services = has(files, (p) =>
    /(?:^|\/)(openapi\.|swagger\.|.*\.proto$|graphql|routes?\/|controllers?\/|api\/)/.test(p),
  );
  push(
    "api",
    "API / services",
    services.length > 0
      ? [`Detected ${services.length} API/service-related path(s).`, ...services.slice(0, 12).map((s) => `- ${s}`)]
      : ["No obvious API/service surface detected from layout."],
    services.slice(0, 12),
  );

  const testFiles = files.filter((f) => f.category === "test").map((f) => f.relativePath);
  push(
    "testing",
    "Testing",
    summary.hasTests
      ? [`${testFiles.length} test file(s) detected. The project has an automated test suite.`]
      : ["No test files detected — unverified changes are higher risk."],
    testFiles.slice(0, 10),
  );

  const deploy = has(files, (p) =>
    /(?:^|\/)(dockerfile|docker-compose.*\.ya?ml|compose.*\.ya?ml|\.github\/workflows\/|helm\/|deploy\/|fly\.toml|vercel\.json|netlify\.toml|k8s\/|kubernetes\/)/.test(p),
  );
  push(
    "deployment",
    "Deployment",
    deploy.length > 0
      ? [`Detected ${deploy.length} deployment-related file(s).`, ...deploy.slice(0, 12).map((s) => `- ${s}`)]
      : ["No deployment configuration detected."],
    deploy.slice(0, 12),
  );

  push(
    "changes",
    "Recent changes",
    commits.slice(0, 15).map((c) => `- ${c.hash.slice(0, 9)} ${c.message.split("\n")[0] ?? ""}`),
    ["git history"],
  );

  push(
    "architecture",
    "Architecture decisions (ADR/RFC)",
    input.architectureDocs.length > 0
      ? input.architectureDocs.map((d) => `- ${d}`)
      : ["No ADR/RFC/decision documents detected."],
    input.architectureDocs.slice(0, 20),
  );

  const docs = files
    .filter((f) => f.category === "doc" || f.category === "readme")
    .map((f) => f.relativePath);
  push(
    "docs",
    "Documentation",
    docs.slice(0, 20).map((d) => `- ${d}`),
    docs.slice(0, 20),
  );

  const bySev: Record<string, number> = {};
  for (const d of diagnostics) bySev[d.severity] = (bySev[d.severity] ?? 0) + 1;
  push(
    "diagnostics",
    "Diagnostics summary",
    diagnostics.length > 0
      ? [Object.entries(bySev).map(([k, n]) => `${n} ${k}`).join(", ") + " currently reported by the editor."]
      : ["No diagnostics reported."],
    ["editor diagnostics"],
  );

  // Derived risks — concrete, not "AI magic".
  const risks: string[] = [];
  if (!files.some((f) => f.relativePath.toLowerCase() === "readme.md")) risks.push("No README.md.");
  if (!summary.hasTests) risks.push("No automated tests detected.");
  if ((bySev["error"] ?? 0) > 0) risks.push(`${bySev["error"]} editor error(s) outstanding.`);
  if (input.architectureDocs.length === 0) risks.push("No recorded architecture decisions (ADR/RFC).");
  push("risks", "Unresolved risks", risks.length > 0 ? risks.map((r) => `- ${r}`) : ["None detected."], ["derived"]);

  return {
    subject: input.subject,
    name: summary.name,
    generatedAt: input.now ?? new Date().toISOString(),
    sections,
  };
}
