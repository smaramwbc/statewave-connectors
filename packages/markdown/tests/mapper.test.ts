import { describe, it, expect } from "vitest";
import { detectKind, mapMarkdownFile, parseFrontmatter } from "../src/index.js";

describe("detectKind", () => {
  it("flags ADR paths", () => {
    expect(detectKind("docs/adrs/0001-use-pnpm.md")).toBe("docs.adr");
    expect(detectKind("docs/ADR-0042-licensing.md")).toBe("docs.adr");
  });
  it("flags RFC paths", () => {
    expect(detectKind("docs/rfcs/0007-protocol.md")).toBe("docs.rfc");
  });
  it("flags decision/architecture paths", () => {
    expect(detectKind("decisions/auth.md")).toBe("docs.decision");
    expect(detectKind("docs/architecture/overview.md")).toBe("docs.decision");
  });
  it("falls back to docs.page", () => {
    expect(detectKind("README.md")).toBe("docs.page");
    expect(detectKind("docs/intro.md")).toBe("docs.page");
  });
});

describe("parseFrontmatter", () => {
  it("parses simple key/value frontmatter", () => {
    const { data, body } = parseFrontmatter(
      `---\ntitle: "Use pnpm"\nstatus: accepted\n---\n# body\n`,
    );
    expect(data.title).toBe("Use pnpm");
    expect(data.status).toBe("accepted");
    expect(body.startsWith("# body")).toBe(true);
  });
  it("returns whole content as body when no frontmatter", () => {
    const { data, body } = parseFrontmatter("# just markdown\n");
    expect(data).toEqual({});
    expect(body).toBe("# just markdown\n");
  });
});

describe("mapMarkdownFile", () => {
  it("produces a docs.adr episode with stable idempotency", () => {
    const file = {
      absolutePath: "/abs/docs/adr/0001.md",
      relativePath: "docs/adr/0001.md",
      hash: "abc123def4567890",
      size: 100,
      mtime: "2026-01-01T00:00:00Z",
      content: `---\ntitle: "Adopt pnpm"\n---\n# Adopt pnpm\n\nWe will use pnpm.`,
    };
    const a = mapMarkdownFile(file, { subject: "repo:acme/widgets" });
    const b = mapMarkdownFile(file, { subject: "repo:acme/widgets" });
    expect(a.kind).toBe("docs.adr");
    expect(a.subject).toBe("repo:acme/widgets");
    expect(a.metadata?.title).toBe("Adopt pnpm");
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });
});
