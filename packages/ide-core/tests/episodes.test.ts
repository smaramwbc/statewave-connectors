import { describe, it, expect } from "vitest";
import {
  workspaceIndexedEpisode,
  projectSummaryEpisode,
  gitContextEpisode,
  docsDetectedEpisode,
  architectureDetectedEpisode,
  fileChangedEpisode,
  diagnosticsReportedEpisode,
  buildProjectSummary,
  type GitContext,
  type ScannedWorkspaceFile,
  type WorkspaceScan,
} from "../src/index.js";

function f(
  relativePath: string,
  category: ScannedWorkspaceFile["category"],
  hash = "aaaabbbbccccdddd",
): ScannedWorkspaceFile {
  return {
    relativePath,
    absolutePath: `/abs/${relativePath}`,
    hash,
    size: 1,
    mtime: "2026-01-01T00:00:00.000Z",
    category,
  };
}

const scan: WorkspaceScan = {
  root: "/abs",
  folderName: "widgets",
  filesVisited: 3,
  filesIgnored: 1,
  files: [f("README.md", "readme"), f("src/index.ts", "source")],
};

const git: GitContext = {
  branch: "main",
  remoteUrl: "git@github.com:acme/widgets.git",
  owner: "acme",
  repo: "widgets",
  host: "github.com",
};

const SUBJECT = "repo:acme/widgets";
const base = { subject: SUBJECT, redactionEnabled: false, occurredAt: "2026-02-02T00:00:00.000Z" };

describe("episode mappers", () => {
  it("produce the correct kinds and a valid shape", () => {
    expect(workspaceIndexedEpisode({ ...base, scan }).kind).toBe(
      "ide.workspace.indexed",
    );
    expect(
      projectSummaryEpisode({
        ...base,
        summary: buildProjectSummary(scan, git, SUBJECT),
      }).kind,
    ).toBe("ide.project.summary");
    expect(gitContextEpisode({ ...base, git }).kind).toBe("ide.git.context");
    expect(docsDetectedEpisode({ ...base, docs: scan.files }).kind).toBe(
      "ide.docs.detected",
    );
    expect(
      architectureDetectedEpisode({
        ...base,
        doc: { relativePath: "docs/adrs/1.md", hash: "h1", content: "# Title\n\nbody" },
      }).kind,
    ).toBe("ide.architecture.detected");
    expect(
      fileChangedEpisode({
        ...base,
        change: {
          relativePath: "src/a.ts",
          absolutePath: "/abs/src/a.ts",
          changeType: "saved",
          hash: "h",
        },
      }).kind,
    ).toBe("ide.file.changed");
    expect(
      diagnosticsReportedEpisode({ ...base, diagnostics: [] }).kind,
    ).toBe("ide.diagnostics.reported");
  });

  it("idempotency is content-addressable: identical state → identical key", () => {
    const a = workspaceIndexedEpisode({ ...base, scan });
    const b = workspaceIndexedEpisode({ ...base, scan });
    expect(a.idempotency_key).toBe(b.idempotency_key);

    const changed: WorkspaceScan = {
      ...scan,
      files: [f("README.md", "readme", "ZZZZ")],
    };
    const c = workspaceIndexedEpisode({ ...base, scan: changed });
    expect(c.idempotency_key).not.toBe(a.idempotency_key);
  });

  it("file.changed dedupes identical content but differs on new content", () => {
    const mk = (hash: string) =>
      fileChangedEpisode({
        ...base,
        change: {
          relativePath: "src/a.ts",
          absolutePath: "/abs/src/a.ts",
          changeType: "saved",
          hash,
        },
      }).idempotency_key;
    expect(mk("h1")).toBe(mk("h1"));
    expect(mk("h1")).not.toBe(mk("h2"));
  });

  it("redaction is applied to text when enabled", () => {
    const ep = architectureDetectedEpisode({
      subject: SUBJECT,
      redactionEnabled: true,
      occurredAt: base.occurredAt,
      doc: {
        relativePath: "docs/adrs/1.md",
        hash: "h",
        content: "# T\n\ncontact me at alice@example.com",
      },
    });
    expect(ep.text).not.toContain("alice@example.com");
    expect(ep.text).toContain("[redacted:email]");
  });

  it("diagnostics digest groups recurring issues and never includes source", () => {
    const ep = diagnosticsReportedEpisode({
      ...base,
      diagnostics: [
        {
          relativePath: "src/a.ts",
          severity: "error",
          code: "2304",
          source: "ts",
          message: "Cannot find name 'foo'",
        },
        {
          relativePath: "src/b.ts",
          severity: "error",
          code: "2304",
          source: "ts",
          message: "Cannot find name 'foo'",
        },
        {
          relativePath: "src/c.ts",
          severity: "warning",
          message: "unused var",
        },
      ],
    });
    expect(ep.text).toContain("×2 error");
    expect(ep.text).toContain("src/a.ts");
    expect(ep.metadata?.total).toBe(3);
    expect((ep.metadata?.by_severity as Record<string, number>).error).toBe(2);
    // No file contents anywhere in the episode.
    expect(JSON.stringify(ep)).not.toContain("export ");
  });

  it("diagnostics messages are redacted when enabled", () => {
    const ep = diagnosticsReportedEpisode({
      subject: SUBJECT,
      redactionEnabled: true,
      occurredAt: base.occurredAt,
      diagnostics: [
        {
          relativePath: "src/a.ts",
          severity: "error",
          message: "bad token sk-ant-abcdefghijklmnopqrstuvwxyz0123",
        },
      ],
    });
    expect(ep.text).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
  });
});
