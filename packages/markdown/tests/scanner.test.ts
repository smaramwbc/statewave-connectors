import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanMarkdownFolder } from "../src/index.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sw-md-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

describe("scanMarkdownFolder", () => {
  it("finds .md and .mdx and skips ignored dirs", async () => {
    await write("README.md", "# hi");
    await write("docs/intro.md", "# intro");
    await write("docs/page.mdx", "# mdx");
    await write("node_modules/skip.md", "# nope");
    await write(".git/skip.md", "# nope");
    await write("dist/skip.md", "# nope");
    await write("not-md.txt", "hello");

    const files = await scanMarkdownFolder(tmpRoot);
    const rels = files.map((f) => f.relativePath).sort();
    expect(rels).toEqual(["README.md", "docs/intro.md", "docs/page.mdx"]);
  });

  it("computes a stable hash for each file", async () => {
    await write("a.md", "# hello");
    const [first] = await scanMarkdownFolder(tmpRoot);
    const [second] = await scanMarkdownFolder(tmpRoot);
    expect(first?.hash).toBe(second?.hash);
    expect(first?.hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("changes hash when content changes", async () => {
    await write("a.md", "# v1");
    const [v1] = await scanMarkdownFolder(tmpRoot);
    await write("a.md", "# v2 changed");
    const [v2] = await scanMarkdownFolder(tmpRoot);
    expect(v1?.hash).not.toBe(v2?.hash);
  });

  it("normalizes relative paths consistently across runs", async () => {
    await write("nested/deeply/page.md", "# nested");
    const [a] = await scanMarkdownFolder(tmpRoot);
    const [b] = await scanMarkdownFolder(tmpRoot);
    expect(a?.relativePath).toBe(b?.relativePath);
    expect(a?.relativePath).toBe("nested/deeply/page.md");
  });
});
