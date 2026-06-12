import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.js";
import { parseGitLog, readmeEpisode, ingestWithProgress } from "../src/commands/mcp-seed.js";
import { Output } from "../src/output.js";
import type { StatewaveClient } from "@statewavedev/mcp-server";
import type { StatewaveEpisode } from "@statewavedev/connectors-core";

const FIELD = "\x1f";
const RECORD = "\x1e";

function rec(hash: string, date: string, author: string, subject: string, body = ""): string {
  return [hash, date, author, subject, body].join(FIELD) + RECORD;
}

function captureStdout() {
  const buf: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    buf.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  return { buf, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseGitLog", () => {
  it("maps each commit to a git.commit episode keyed on its sha", () => {
    const raw =
      rec("abc123", "2026-06-01T10:00:00+00:00", "Ada", "Add widget", "with a body\nspanning lines") +
      rec("def456", "2026-06-02T11:00:00+00:00", "Lin", "Fix bug");
    const eps = parseGitLog(raw, "repo:demo");
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({
      subject: "repo:demo",
      kind: "git.commit",
      occurred_at: "2026-06-01T10:00:00+00:00",
      idempotency_key: "git:commit:abc123",
    });
    expect(eps[0].text).toContain("Add widget");
    expect(eps[0].text).toContain("spanning lines");
    expect(eps[0].metadata).toMatchObject({ author: "Ada" });
    expect(eps[1].text).toBe("Fix bug");
  });

  it("ignores blank records and rows without a subject", () => {
    const raw = rec("aaa", "2026-06-01T00:00:00+00:00", "X", "Real commit") + RECORD + "   " + RECORD;
    expect(parseGitLog(raw, "repo:x")).toHaveLength(1);
  });
});

describe("readmeEpisode", () => {
  it("produces a stable-keyed repo.readme episode so re-seeding updates in place", () => {
    const ep = readmeEpisode("# Demo\nhello", "repo:demo", "2026-06-10T00:00:00Z");
    expect(ep.kind).toBe("repo.readme");
    expect(ep.idempotency_key).toBe("git:readme:repo:demo");
    expect(ep.text).toContain("# Demo");
  });

  it("truncates very large READMEs", () => {
    const ep = readmeEpisode("x".repeat(20_000), "repo:demo", "2026-06-10T00:00:00Z");
    expect(ep.text.length).toBe(16_000);
  });
});

describe("ingestWithProgress", () => {
  function ep(id: string): StatewaveEpisode {
    return {
      subject: "repo:x",
      kind: "git.commit",
      text: id,
      occurred_at: "2026-06-01T00:00:00Z",
      source: { type: "git", id },
      idempotency_key: `git:commit:${id}`,
    };
  }

  it("ingests every episode and reports counts (json mode = silent)", async () => {
    const seen: string[] = [];
    const client = {
      ingestEpisode: async (e: StatewaveEpisode) => {
        seen.push(e.source.id);
        return { idempotency_key: e.idempotency_key };
      },
    } as unknown as StatewaveClient;
    const out = new Output({ json: true });
    const eps = Array.from({ length: 25 }, (_, i) => ep(`c${i}`));
    const r = await ingestWithProgress(client, eps, 8, out);
    expect(r.ingested).toBe(25);
    expect(r.failed).toBe(0);
    expect(seen).toHaveLength(25);
  });

  it("captures failures without aborting the rest", async () => {
    const client = {
      ingestEpisode: async (e: StatewaveEpisode) => {
        if (e.source.id === "bad") throw new Error("nope");
        return { idempotency_key: e.idempotency_key };
      },
    } as unknown as StatewaveClient;
    const out = new Output({ json: true });
    const eps = [ep("ok1"), ep("bad"), ep("ok2")];
    const r = await ingestWithProgress(client, eps, 2, out);
    expect(r.ingested).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.failures[0]).toContain("bad");
  });
});

describe("mcp seed command (dry run)", () => {
  it("reports no signal outside a git repo with no README", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-seed-"));
    const prev = process.cwd();
    process.chdir(dir);
    const stdout = captureStdout();
    const errBuf: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      errBuf.push(String(c));
      return true;
    });
    const code = await main(["mcp", "seed"]);
    stdout.restore();
    errSpy.mockRestore();
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
    expect(code).toBe(1);
    expect(errBuf.join("")).toContain("no local signal to seed");
  });

  it("lists recent commits from a real repo without ingesting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-seed-"));
    let gitOk = true;
    try {
      const git = (...a: string[]) =>
        execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "Tester");
      await writeFile(join(dir, "README.md"), "# Seed Demo\n");
      git("add", "-A");
      git("commit", "-q", "-m", "Seed me: first commit");
    } catch {
      gitOk = false;
    }
    if (!gitOk) {
      await rm(dir, { recursive: true, force: true });
      return; // git unavailable in this environment — skip
    }
    const prev = process.cwd();
    process.chdir(dir);
    const { buf, restore } = captureStdout();
    const code = await main(["mcp", "seed", "--subject", "repo:seed-demo"]);
    restore();
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    const out = buf.join("");
    expect(out).toContain("Seed plan for repo:seed-demo");
    expect(out).toContain("Seed me: first commit");
    expect(out).toContain("README overview episode");
    expect(out).toContain("dry run");
  });
});
