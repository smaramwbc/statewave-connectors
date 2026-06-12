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
import { parseClientSelection } from "../src/commands/quickstart.js";
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
