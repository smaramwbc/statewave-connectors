import { describe, it, expect } from "vitest";
import {
  buildProjectUnderstanding,
  buildProjectSummary,
  type GitContext,
  type ScannedWorkspaceFile,
  type WorkspaceScan,
} from "../src/index.js";

function f(p: string, c: ScannedWorkspaceFile["category"]): ScannedWorkspaceFile {
  return { relativePath: p, absolutePath: `/a/${p}`, hash: "h", size: 1, mtime: "t", category: c };
}

const scan: WorkspaceScan = {
  root: "/a",
  folderName: "widgets",
  filesVisited: 9,
  filesIgnored: 1,
  files: [
    f("README.md", "readme"),
    f("package.json", "node-manifest"),
    f("src/index.ts", "source"),
    f("tests/x.test.ts", "test"),
    f("Dockerfile", "dockerfile"),
    f("docs/adrs/0001.md", "adr"),
  ],
};
const git: GitContext = {
  branch: "main",
  remoteUrl: "git@github.com:acme/widgets.git",
  owner: "acme",
  repo: "widgets",
  host: "github.com",
};

describe("buildProjectUnderstanding", () => {
  it("produces sectioned, provenanced understanding deterministically", () => {
    const summary = buildProjectSummary(scan, git, "repo:acme.widgets");
    const u = buildProjectUnderstanding({
      subject: "repo:acme.widgets",
      summary,
      scan,
      git,
      commits: [{ hash: "abcdef123456", message: "feat: thing\n\nbody" }],
      diagnostics: [
        { relativePath: "src/index.ts", severity: "error", message: "x" },
      ],
      architectureDocs: ["docs/adrs/0001.md"],
      now: "2026-05-17T00:00:00.000Z",
    });

    const ids = u.sections.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "overview",
        "stack",
        "testing",
        "deployment",
        "changes",
        "architecture",
        "diagnostics",
        "risks",
      ]),
    );
    expect(u.generatedAt).toBe("2026-05-17T00:00:00.000Z");

    const testing = u.sections.find((s) => s.id === "testing")!;
    expect(testing.body.join(" ")).toMatch(/test file/);

    const deploy = u.sections.find((s) => s.id === "deployment")!;
    expect(deploy.sources).toContain("Dockerfile");

    const changes = u.sections.find((s) => s.id === "changes")!;
    expect(changes.body[0]).toContain("abcdef123"); // short hash, subject line
    expect(changes.body[0]).not.toContain("body");

    const risks = u.sections.find((s) => s.id === "risks")!;
    expect(risks.body.join(" ")).toMatch(/error/); // 1 outstanding error
  });

  it("flags missing README/tests/ADRs as concrete risks", () => {
    const bare: WorkspaceScan = {
      ...scan,
      files: [f("src/index.ts", "source")],
    };
    const summary = buildProjectSummary(bare, git, "repo:acme.widgets");
    const u = buildProjectUnderstanding({
      subject: "repo:acme.widgets",
      summary,
      scan: bare,
      git,
      commits: [],
      diagnostics: [],
      architectureDocs: [],
    });
    const risks = u.sections.find((s) => s.id === "risks")!;
    const text = risks.body.join(" ");
    expect(text).toMatch(/No README/);
    expect(text).toMatch(/No automated tests/);
    expect(text).toMatch(/architecture decisions/);
  });
});
