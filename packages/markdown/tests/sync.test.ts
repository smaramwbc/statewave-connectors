import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMarkdownConnector } from "../src/index.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sw-md-sync-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string, mtimeMs?: number): Promise<void> {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    await fs.utimes(abs, t, t);
  }
}

describe("markdown connector dry-run sync", () => {
  it("requires a subject and refuses without one", async () => {
    await write("a.md", "# a");
    const c = createMarkdownConnector({ root: tmpRoot });
    await expect(c.sync({ dryRun: true })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "config_invalid",
    });
  });

  it("never ingests in dry-run; emits a kind histogram", async () => {
    await write("README.md", "# overview");
    await write("docs/adrs/0001-use-pnpm.md", "# Use pnpm");
    await write("docs/rfcs/0007-protocol.md", "# Protocol");
    await write("docs/architecture/overview.md", "# Architecture");

    const c = createMarkdownConnector({ root: tmpRoot, subject: "repo:acme/widgets" });
    const result = await c.sync({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.ingested).toBe(0);
    expect(result.summary.total).toBe(4);
    // Two decision-style kinds + one page (README) + one decision (architecture/).
    expect(result.summary.kinds["docs.adr"]).toBe(1);
    expect(result.summary.kinds["docs.rfc"]).toBe(1);
    expect(result.summary.kinds["docs.decision"]).toBe(1);
    expect(result.summary.kinds["docs.page"]).toBe(1);
    expect(result.summary.details?.files_scanned).toBe(4);
    expect(result.summary.details?.files_mapped).toBe(4);
  });

  it("filters by --since using file mtime", async () => {
    const old = new Date("2026-01-01T00:00:00Z").getTime();
    const fresh = new Date("2026-06-01T00:00:00Z").getTime();
    await write("old.md", "# old", old);
    await write("fresh.md", "# fresh", fresh);

    const c = createMarkdownConnector({ root: tmpRoot, subject: "repo:acme/widgets" });
    const result = await c.sync({
      dryRun: true,
      since: "2026-03-01T00:00:00Z",
    });
    expect(result.episodes.map((e) => e.source.id)).toEqual(["fresh.md"]);
    expect(result.summary.details?.files_dropped_since).toBe(1);
  });

  it("honours --include and --exclude path substrings", async () => {
    await write("docs/adrs/0001.md", "# adr");
    await write("docs/internal/secret.md", "# internal");
    await write("README.md", "# readme");

    const c = createMarkdownConnector({ root: tmpRoot, subject: "repo:acme/widgets" });
    const inc = await c.sync({ dryRun: true, include: ["docs/"] });
    expect(inc.episodes.map((e) => e.source.id).sort()).toEqual([
      "docs/adrs/0001.md",
      "docs/internal/secret.md",
    ]);

    const ex = await c.sync({ dryRun: true, exclude: ["internal"] });
    expect(ex.episodes.map((e) => e.source.id).sort()).toEqual(["README.md", "docs/adrs/0001.md"]);
    expect(ex.summary.details?.files_dropped_exclude).toBe(1);
  });

  it("--max-items caps mapped episodes and reports skipped", async () => {
    for (let i = 0; i < 5; i++) await write(`p${i}.md`, `# p${i}`);
    const c = createMarkdownConnector({ root: tmpRoot, subject: "repo:acme/widgets" });
    const result = await c.sync({ dryRun: true, maxItems: 2 });
    expect(result.episodes).toHaveLength(2);
    expect(result.skipped).toBe(3);
    expect(result.summary.details?.files_dropped_max_items).toBe(3);
  });

  it("reads frontmatter title and date when present", async () => {
    await write(
      "docs/adrs/0042-licensing.md",
      `---\ntitle: "Licensing"\ndate: 2026-04-01T00:00:00Z\n---\n\n# Licensing\n\nWe chose Apache.`,
    );
    const c = createMarkdownConnector({ root: tmpRoot, subject: "repo:acme/widgets" });
    const result = await c.sync({ dryRun: true });
    const ep = result.episodes[0];
    expect(ep?.kind).toBe("docs.adr");
    expect(ep?.metadata?.title).toBe("Licensing");
    expect(ep?.occurred_at).toBe("2026-04-01T00:00:00.000Z");
  });
});
