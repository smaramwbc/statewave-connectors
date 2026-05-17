import { describe, it, expect } from "vitest";
import {
  docsContentEpisodes,
  gitHistoryEpisode,
  codeStructureEpisode,
} from "../src/index.js";

const base = {
  subject: "repo:acme.widgets",
  redactionEnabled: false,
  occurredAt: "2026-02-02T00:00:00.000Z",
};

describe("docsContentEpisodes (markdown connector reuse)", () => {
  it("emits full-content docs.* episodes under our subject", () => {
    const eps = docsContentEpisodes({
      ...base,
      docs: [
        {
          absolutePath: "/abs/README.md",
          relativePath: "README.md",
          hash: "abc1230000000000",
          size: 20,
          mtime: "2026-01-01T00:00:00.000Z",
          content: "# Widgets\n\nThe body text.",
        },
        {
          absolutePath: "/abs/docs/adrs/0001.md",
          relativePath: "docs/adrs/0001.md",
          hash: "def4560000000000",
          size: 10,
          mtime: "2026-01-01T00:00:00.000Z",
          content: "# Use pnpm\n\nDecision body.",
        },
      ],
    });
    expect(eps).toHaveLength(2);
    expect(eps[0]!.subject).toBe("repo:acme.widgets");
    expect(eps[0]!.text).toContain("The body text.");
    expect(eps[1]!.kind).toBe("docs.adr");
    expect(eps[0]!.occurred_at).toBe(base.occurredAt);
  });

  it("redacts content when enabled", () => {
    const [ep] = docsContentEpisodes({
      subject: "repo:acme.widgets",
      redactionEnabled: true,
      docs: [
        {
          absolutePath: "/abs/README.md",
          relativePath: "README.md",
          hash: "h0000000000000000",
          size: 10,
          mtime: "2026-01-01T00:00:00.000Z",
          content: "# T\n\nmail me at jane@example.com",
        },
      ],
    });
    expect(ep!.text).not.toContain("jane@example.com");
    expect(ep!.text).toContain("[redacted:email]");
  });
});

describe("gitHistoryEpisode", () => {
  const commits = [
    { hash: "aaaaaaaaaaaa1", message: "feat: x", authorName: "Ada", date: "2026-02-01" },
    { hash: "bbbbbbbbbbbb2", message: "fix: y\n\nbody", authorName: "Lin" },
  ];
  it("digests commits and is content-addressable", () => {
    const a = gitHistoryEpisode({ ...base, commits });
    expect(a.kind).toBe("ide.git.history");
    expect(a.text).toContain("feat: x");
    expect(a.text).not.toContain("body"); // only the subject line
    expect(a.metadata?.commit_count).toBe(2);
    const b = gitHistoryEpisode({ ...base, commits });
    expect(a.idempotency_key).toBe(b.idempotency_key);
    const c = gitHistoryEpisode({
      ...base,
      commits: [...commits, { hash: "ccc3", message: "z" }],
    });
    expect(c.idempotency_key).not.toBe(a.idempotency_key);
  });
});

describe("codeStructureEpisode", () => {
  const files = [
    {
      relativePath: "src/a.ts",
      hash: "h1",
      symbols: [
        { name: "foo", kind: "function", line: 1 },
        { name: "Bar", kind: "class", line: 10 },
      ],
    },
  ];
  it("lists symbols only (no bodies) and is idempotent", () => {
    const a = codeStructureEpisode({ ...base, files });
    expect(a.kind).toBe("ide.code.structure");
    expect(a.text).toContain("function foo:1");
    expect(a.text).toContain("class Bar:10");
    expect(a.metadata?.symbol_count).toBe(2);
    const b = codeStructureEpisode({ ...base, files });
    expect(a.idempotency_key).toBe(b.idempotency_key);
    const c = codeStructureEpisode({
      ...base,
      files: [{ relativePath: "src/a.ts", hash: "h2", symbols: [] }],
    });
    expect(c.idempotency_key).not.toBe(a.idempotency_key);
  });
});
