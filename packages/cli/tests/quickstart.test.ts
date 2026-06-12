import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.js";
import {
  renderComposeFile,
  checkHealth,
  waitForHealth,
  llmEnv,
  detectClients,
} from "../src/commands/quickstart.js";
import { parseClientSelection, parseRepoSelection, subjectCounts, quickstartOutcome } from "../src/commands/quickstart.js";
import { buildServerSpec, CLIENTS, findClient } from "../src/commands/mcp-clients.js";
import { green, colorEnabled } from "../src/colors.js";
import { withSpinner } from "../src/spinner.js";

function okFetch(): typeof fetch {
  return (async () => new Response("{}", { status: 200 })) as typeof fetch;
}
function downFetch(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe("renderComposeFile", () => {
  it("includes db + api + admin with the requested ports", () => {
    const yaml = renderComposeFile({ apiPort: 8100, adminPort: 8080, includeAdmin: true });
    expect(yaml).toContain("pgvector/pgvector:pg16");
    expect(yaml).toContain("statewavedev/statewave:latest");
    expect(yaml).toContain('"8100:8100"');
    expect(yaml).toContain("statewavedev/statewave-admin:latest");
    expect(yaml).toContain('"8080:8080"');
    expect(yaml).toContain('STATEWAVE_DEBUG: "true"');
  });

  it("omits the admin service when includeAdmin is false", () => {
    const yaml = renderComposeFile({ apiPort: 9000, adminPort: 8080, includeAdmin: false });
    expect(yaml).not.toContain("statewave-admin");
    expect(yaml).toContain('"9000:8100"');
  });

  it("references LLM env with keyless defaults (key never hard-coded in the file)", () => {
    const yaml = renderComposeFile({ apiPort: 8100, adminPort: 8080, includeAdmin: true });
    expect(yaml).toContain("STATEWAVE_COMPILER_TYPE: ${STATEWAVE_COMPILER_TYPE:-heuristic}");
    expect(yaml).toContain("STATEWAVE_EMBEDDING_PROVIDER: ${STATEWAVE_EMBEDDING_PROVIDER:-stub}");
    expect(yaml).toContain("STATEWAVE_LITELLM_API_KEY: ${STATEWAVE_LITELLM_API_KEY:-}");
    expect(yaml).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

describe("llmEnv", () => {
  it("is empty without a key (server stays heuristic + stub)", () => {
    expect(llmEnv()).toEqual({});
    expect(llmEnv(undefined, "gpt-4o-mini")).toEqual({});
  });

  it("turns on the LLM compiler + embeddings when a key is given", () => {
    const env = llmEnv("sk-test");
    expect(env.STATEWAVE_COMPILER_TYPE).toBe("llm");
    expect(env.STATEWAVE_EMBEDDING_PROVIDER).toBe("litellm");
    expect(env.STATEWAVE_LITELLM_API_KEY).toBe("sk-test");
    expect(env.STATEWAVE_LITELLM_MODEL).toBeUndefined();
  });

  it("passes a custom model through", () => {
    expect(llmEnv("sk-test", "anthropic/claude-3-5-haiku").STATEWAVE_LITELLM_MODEL).toBe(
      "anthropic/claude-3-5-haiku",
    );
  });
});

describe("health checks", () => {
  it("checkHealth is true on 200, false when unreachable", async () => {
    expect(await checkHealth("http://localhost:8100", okFetch())).toBe(true);
    expect(await checkHealth("http://localhost:8100", downFetch())).toBe(false);
  });

  it("waitForHealth gives up after the timeout when never healthy", async () => {
    const ok = await waitForHealth("http://localhost:8100", {
      timeoutMs: 30,
      intervalMs: 10,
      fetchImpl: downFetch(),
    });
    expect(ok).toBe(false);
  });

  it("waitForHealth returns true once the server answers", async () => {
    let calls = 0;
    const flips: typeof fetch = (async () => {
      calls += 1;
      if (calls < 2) throw new Error("not yet");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const ok = await waitForHealth("http://localhost:8100", {
      timeoutMs: 1000,
      intervalMs: 5,
      fetchImpl: flips,
    });
    expect(ok).toBe(true);
  });
});

describe("buildServerSpec --server-bin", () => {
  it("launches a local bin via the current node executable", () => {
    const spec = buildServerSpec({ serverBin: "/abs/dist/cli.js", statewaveUrl: "http://localhost:8100" });
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual(["/abs/dist/cli.js"]);
    expect(spec.env.STATEWAVE_URL).toBe("http://localhost:8100");
  });

  it("still defaults to npx when no bin is given", () => {
    const spec = buildServerSpec();
    expect(spec.command).toBe("npx");
  });
});

describe("mcp init --server-bin (end to end)", () => {
  it("writes a config that launches the local bin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-sb-"));
    const prev = process.cwd();
    process.chdir(dir);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await main(["mcp", "init", "claude", "--server-bin", "/abs/cli.js", "--write"]);
    spy.mockRestore();
    process.chdir(prev);
    expect(code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    expect(cfg.mcpServers.statewave.command).toBe(process.execPath);
    expect(cfg.mcpServers.statewave.args).toEqual(["/abs/cli.js"]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("parseClientSelection", () => {
  const detected = [findClient("claude-desktop")!, findClient("cursor")!];

  it("Enter selects the detected set", () => {
    expect(parseClientSelection("", detected).map((c) => c.id)).toEqual(["claude-desktop", "cursor"]);
  });

  it("Enter falls back to all when nothing was detected", () => {
    expect(parseClientSelection("", [])).toHaveLength(CLIENTS.length);
  });

  it("'a'/'all' selects everything, 'n'/'none' selects nothing", () => {
    expect(parseClientSelection("a", detected)).toHaveLength(CLIENTS.length);
    expect(parseClientSelection("all", detected)).toHaveLength(CLIENTS.length);
    expect(parseClientSelection("n", detected)).toEqual([]);
    expect(parseClientSelection("none", detected)).toEqual([]);
  });

  it("parses 1-based indices, dedupes, and ignores out-of-range", () => {
    const ids = parseClientSelection("1,3,3,99", detected).map((c) => c.id);
    expect(ids).toEqual([CLIENTS[0]!.id, CLIENTS[2]!.id]);
    expect(parseClientSelection("2 4", detected).map((c) => c.id)).toEqual([
      CLIENTS[1]!.id,
      CLIENTS[3]!.id,
    ]);
  });

  it("returns empty on unrecognized input (caller handles the fallback)", () => {
    expect(parseClientSelection("xyz", detected)).toEqual([]);
  });
});

describe("parseRepoSelection", () => {
  it("Enter / a / all select everything", () => {
    expect(parseRepoSelection("", 3)).toEqual([0, 1, 2]);
    expect(parseRepoSelection("a", 3)).toEqual([0, 1, 2]);
    expect(parseRepoSelection("all", 3)).toEqual([0, 1, 2]);
  });
  it("n / none select nothing", () => {
    expect(parseRepoSelection("n", 3)).toEqual([]);
    expect(parseRepoSelection("none", 3)).toEqual([]);
  });
  it("parses 1-based indices, dedupes, drops out-of-range", () => {
    expect(parseRepoSelection("1,3,3,9", 3)).toEqual([0, 2]);
    expect(parseRepoSelection("2 1", 3)).toEqual([1, 0]);
  });
});

describe("subjectCounts (verified via /v1/timeline, not the lagging /v1/subjects)", () => {
  it("counts episodes from the timeline and hits the timeline endpoint", async () => {
    let calledUrl = "";
    const f = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ subject_id: "repo:acme.demo", episodes: [{}, {}, {}] }), { status: 200 });
    }) as typeof fetch;
    expect(await subjectCounts("http://localhost:8100", "repo:acme.demo", f)).toEqual({ episodes: 3 });
    expect(calledUrl).toContain("/v1/timeline");
    expect(calledUrl).toContain("subject_id=repo%3Aacme.demo");
  });
  it("returns 0 episodes for an unseeded subject and null on a bad response", async () => {
    const empty = (async () => new Response(JSON.stringify({ episodes: [] }), { status: 200 })) as typeof fetch;
    expect(await subjectCounts("http://localhost:8100", "repo:x", empty)).toEqual({ episodes: 0 });
    const bad = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    expect(await subjectCounts("http://localhost:8100", "repo:x", bad)).toBeNull();
  });
});

describe("detectClients", () => {
  it("returns a subset of known client ids", () => {
    const ids = detectClients();
    const known = new Set(CLIENTS.map((c) => c.id));
    expect(Array.isArray(ids)).toBe(true);
    for (const id of ids) expect(known.has(id)).toBe(true);
  });
});

describe("colors + spinner (no-op when not a TTY)", () => {
  it("colors are disabled in the test (non-TTY) environment", () => {
    expect(colorEnabled()).toBe(false);
    expect(green("ok")).toBe("ok"); // no ANSI escape wrapping
  });

  it("withSpinner returns the task result and stays silent when inactive", async () => {
    const result = await withSpinner("working", async () => 42, { active: false });
    expect(result).toBe(42);
  });
});

describe("quickstart help", () => {
  it("appears in root help and has its own help page", async () => {
    const buf: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      buf.push(String(c));
      return true;
    });
    await main([]);
    await main(["quickstart", "--help"]);
    spy.mockRestore();
    const out = buf.join("");
    expect(out).toContain("quickstart");
    expect(out).toContain("docker compose");
    expect(out).toContain("--down");
  });
});

describe("quickstartOutcome — honest severity + exit code", () => {
  it("is clean (ok / exit 0) when every seed verified and no warnings", () => {
    expect(quickstartOutcome([{ ok: true }, { ok: true }], 0)).toEqual({
      severity: "ok",
      exitCode: 0,
      failedSeeds: 0,
    });
  });

  it("is a warning (exit 0) for advisory issues only — partial seeds still all ok", () => {
    // e.g. the optional IDE Companion CLI wasn't found, but both repos seeded.
    expect(quickstartOutcome([{ ok: true }], 2)).toEqual({
      severity: "warning",
      exitCode: 0,
      failedSeeds: 0,
    });
  });

  it("is an error (exit 1) when a requested seed failed — partial success stays partial", () => {
    expect(quickstartOutcome([{ ok: true }, { ok: false }], 0)).toEqual({
      severity: "error",
      exitCode: 1,
      failedSeeds: 1,
    });
  });

  it("a seed failure outranks warnings (error wins, exit 1)", () => {
    expect(quickstartOutcome([{ ok: false }], 3).severity).toBe("error");
    expect(quickstartOutcome([{ ok: false }], 3).exitCode).toBe(1);
  });

  it("no seeds + no warnings is clean (server/config-only run)", () => {
    expect(quickstartOutcome([], 0)).toEqual({ severity: "ok", exitCode: 0, failedSeeds: 0 });
  });
});

describe("askValid — re-asks on invalid input instead of proceeding", () => {
  it("loops until the answer parses, surfacing a hint each time", async () => {
    const { askValid } = await import("../src/commands/quickstart.js");
    const answers = ["8", "garbage", "2"]; // two invalid, then a valid choice
    let i = 0;
    const ask = async () => answers[i++]!;
    const logs: string[] = [];
    const out = { log: (s: string) => logs.push(s) } as unknown as import("../src/output.js").Output;
    const result = await askValid(out, ask, "pick: ", (a: string) =>
      a.trim() === "2" ? { ok: true as const, value: "two" } : { ok: false as const, message: "enter 1 or 2." },
    );
    expect(result).toBe("two");
    expect(i).toBe(3); // asked three times (didn't stop at the first invalid)
    expect(logs.filter((l) => l.includes("enter 1 or 2.")).length).toBe(2);
  });
});

describe("looksLikePath — a typed path is recognised, not skipped", () => {
  it("recognises absolute / home / relative / Windows paths", async () => {
    const { looksLikePath } = await import("../src/commands/quickstart.js");
    expect(looksLikePath("/Users/smaram/Documents/GitHub")).toBe(true); // the reported case
    expect(looksLikePath("~/code")).toBe(true);
    expect(looksLikePath("./repo")).toBe(true);
    expect(looksLikePath("../repo")).toBe(true);
    expect(looksLikePath("C:\\Users\\me\\code")).toBe(true);
  });
  it("does NOT treat menu answers (numbers, keywords) as paths", async () => {
    const { looksLikePath } = await import("../src/commands/quickstart.js");
    expect(looksLikePath("1")).toBe(false);
    expect(looksLikePath("2,3")).toBe(false);
    expect(looksLikePath("n")).toBe(false);
    expect(looksLikePath("all")).toBe(false);
    expect(looksLikePath("")).toBe(false);
  });
});
