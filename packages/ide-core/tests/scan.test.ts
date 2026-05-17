import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanWorkspace } from "../src/index.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ide-core-scan-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "docs", "adrs"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "lib"), { recursive: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "# Demo\n");
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfile\n");
  await fs.writeFile(path.join(root, "src", "index.ts"), "export const a = 1;\n");
  await fs.writeFile(
    path.join(root, "docs", "adrs", "0001-use-statewave.md"),
    "# ADR 1\n",
  );
  await fs.writeFile(path.join(root, "node_modules", "lib", "x.js"), "noise\n");
  await fs.writeFile(path.join(root, "dist", "bundle.js"), "built\n");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("scanWorkspace", () => {
  it("collects classified files and skips ignored dirs/lockfiles", async () => {
    const scan = await scanWorkspace(root);
    const rels = scan.files.map((f) => f.relativePath).sort();

    expect(rels).toContain("README.md");
    expect(rels).toContain("package.json");
    expect(rels).toContain("src/index.ts");
    expect(rels).toContain("docs/adrs/0001-use-statewave.md");

    expect(rels.some((r) => r.startsWith("node_modules/"))).toBe(false);
    expect(rels.some((r) => r.startsWith("dist/"))).toBe(false);
    expect(rels).not.toContain("pnpm-lock.yaml");

    expect(scan.folderName).toBe(path.basename(root));
    expect(scan.filesIgnored).toBeGreaterThan(0);

    const adr = scan.files.find(
      (f) => f.relativePath === "docs/adrs/0001-use-statewave.md",
    );
    expect(adr?.category).toBe("adr");
    expect(adr?.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("includeGlobs can re-enter an ignored directory", async () => {
    const scan = await scanWorkspace(root, { includeGlobs: ["dist/**"] });
    const rels = scan.files.map((f) => f.relativePath);
    expect(rels).toContain("dist/bundle.js");
    // node_modules still ignored — include glob was scoped to dist.
    expect(rels.some((r) => r.startsWith("node_modules/"))).toBe(false);
  });

  it("is deterministic (sorted) across runs", async () => {
    const a = await scanWorkspace(root);
    const b = await scanWorkspace(root);
    expect(a.files.map((f) => f.relativePath)).toEqual(
      b.files.map((f) => f.relativePath),
    );
  });
});
