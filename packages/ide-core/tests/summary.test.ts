import { describe, it, expect } from "vitest";
import {
  buildProjectSummary,
  renderProjectSummaryText,
  type GitContext,
  type ScannedWorkspaceFile,
  type WorkspaceScan,
} from "../src/index.js";

function file(
  relativePath: string,
  category: ScannedWorkspaceFile["category"],
): ScannedWorkspaceFile {
  return {
    relativePath,
    absolutePath: `/abs/${relativePath}`,
    hash: "deadbeefdeadbeef",
    size: 10,
    mtime: "2026-01-01T00:00:00.000Z",
    category,
  };
}

const scan: WorkspaceScan = {
  root: "/abs",
  folderName: "widgets",
  filesVisited: 6,
  filesIgnored: 2,
  files: [
    file("README.md", "readme"),
    file("package.json", "node-manifest"),
    file("pnpm-workspace.yaml", "workspace-manifest"),
    file("tsconfig.json", "tsconfig"),
    file("src/index.ts", "source"),
    file("tests/x.test.ts", "test"),
    file("docs/adrs/0001.md", "adr"),
  ],
};

const git: GitContext = {
  branch: "feat/x",
  remoteUrl: "git@github.com:acme/widgets.git",
  owner: "acme",
  repo: "widgets",
  host: "github.com",
};

describe("buildProjectSummary", () => {
  it("derives toolchain, languages, conventions, and docs", () => {
    const s = buildProjectSummary(scan, git, "repo:acme/widgets");
    expect(s.name).toBe("widgets");
    expect(s.subject).toBe("repo:acme/widgets");
    expect(s.languages).toContain("TypeScript");
    expect(s.toolchain).toContain("pnpm");
    expect(s.toolchain).toContain("typescript");
    expect(s.hasTests).toBe(true);
    expect(s.architectureDocs).toContain("docs/adrs/0001.md");
    expect(s.conventions).toContain("monorepo workspace");
    expect(s.conventions).toContain("has an automated test suite");
    expect(s.layout).toContain("docs");
    expect(s.layout).toContain("src");
  });

  it("renders a compact, self-contained text", () => {
    const s = buildProjectSummary(scan, git, "repo:acme/widgets");
    const text = renderProjectSummaryText(s);
    expect(text).toContain("# Project: widgets");
    expect(text).toContain("Subject: repo:acme/widgets");
    expect(text).toContain("Branch: feat/x");
    expect(text).toContain("docs/adrs/0001.md");
  });
});
