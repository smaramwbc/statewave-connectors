import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.js";
import {
  buildServerSpec,
  findClient,
  renderJsonBlock,
  renderTomlBlock,
  MCP_SERVER_PACKAGE,
  DEFAULT_STATEWAVE_URL,
} from "../src/commands/mcp-clients.js";
import {
  appendTomlConfig,
  mergeInstruction,
  mergeJsonConfig,
  renderInstructionBlock,
} from "../src/commands/mcp-init.js";

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

describe("buildServerSpec", () => {
  it("defaults to npx + the mcp-server package and the default URL, no secrets", () => {
    const spec = buildServerSpec();
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", MCP_SERVER_PACKAGE]);
    expect(spec.env.STATEWAVE_URL).toBe(DEFAULT_STATEWAVE_URL);
    expect(JSON.stringify(spec.env)).not.toMatch(/API_KEY/);
  });

  it("honors a custom URL and tenant but never adds an API key", () => {
    const spec = buildServerSpec({
      statewaveUrl: "https://memory.acme.dev",
      tenantId: "acme",
      name: "brain",
    });
    expect(spec.name).toBe("brain");
    expect(spec.env.STATEWAVE_URL).toBe("https://memory.acme.dev");
    expect(spec.env.STATEWAVE_TENANT_ID).toBe("acme");
  });
});

describe("config block rendering", () => {
  it("renders Claude Code JSON under mcpServers without a type field", () => {
    const client = findClient("claude")!;
    const block = JSON.parse(renderJsonBlock(buildServerSpec(), client));
    expect(block.mcpServers.statewave.command).toBe("npx");
    expect(block.mcpServers.statewave.type).toBeUndefined();
  });

  it("renders VS Code JSON under `servers` with type stdio", () => {
    const client = findClient("vscode")!;
    const block = JSON.parse(renderJsonBlock(buildServerSpec(), client));
    expect(block.mcpServers).toBeUndefined();
    expect(block.servers.statewave.type).toBe("stdio");
  });

  it("renders Codex TOML as an [mcp_servers.<name>] table", () => {
    const toml = renderTomlBlock(buildServerSpec({ name: "statewave" }));
    expect(toml).toContain("[mcp_servers.statewave]");
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('STATEWAVE_URL = "http://localhost:8100"');
  });
});

describe("mergeJsonConfig", () => {
  it("creates the container when the file is absent", () => {
    const client = findClient("claude")!;
    const merged = JSON.parse(mergeJsonConfig(null, buildServerSpec(), client));
    expect(merged.mcpServers.statewave).toBeDefined();
  });

  it("preserves other servers when merging", () => {
    const client = findClient("claude")!;
    const existing = JSON.stringify({ mcpServers: { other: { command: "foo" } } });
    const merged = JSON.parse(mergeJsonConfig(existing, buildServerSpec(), client));
    expect(merged.mcpServers.other.command).toBe("foo");
    expect(merged.mcpServers.statewave).toBeDefined();
  });

  it("throws on malformed JSON instead of clobbering", () => {
    const client = findClient("claude")!;
    expect(() => mergeJsonConfig("{ not json", buildServerSpec(), client)).toThrow(/valid JSON/);
  });
});

describe("appendTomlConfig", () => {
  it("returns just the block for an empty file", () => {
    const { content, skipped } = appendTomlConfig(null, buildServerSpec());
    expect(skipped).toBe(false);
    expect(content).toContain("[mcp_servers.statewave]");
  });

  it("skips when the table already exists", () => {
    const existing = "[mcp_servers.statewave]\ncommand = \"npx\"\n";
    const { skipped, content } = appendTomlConfig(existing, buildServerSpec());
    expect(skipped).toBe(true);
    expect(content).toBe(existing);
  });

  it("appends after existing content without duplicating", () => {
    const existing = "[mcp_servers.other]\ncommand = \"x\"\n";
    const { content, skipped } = appendTomlConfig(existing, buildServerSpec());
    expect(skipped).toBe(false);
    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain("[mcp_servers.statewave]");
  });
});

describe("instruction block", () => {
  it("scopes the guidance to the subject and server id", () => {
    const block = renderInstructionBlock("repo:acme/platform", "statewave");
    expect(block).toContain("repo:acme/platform");
    expect(block).toContain("statewave_get_context");
    expect(block).toContain("statewave:begin");
  });

  it("appends to an existing file the first time", () => {
    const block = renderInstructionBlock("repo:x", "statewave");
    const merged = mergeInstruction("# My project\n", block);
    expect(merged).toContain("# My project");
    expect(merged).toContain("statewave_get_context");
  });

  it("is idempotent — re-running replaces the managed block, not duplicates it", () => {
    const block = renderInstructionBlock("repo:x", "statewave");
    const once = mergeInstruction("# P\n", block);
    const twice = mergeInstruction(once, renderInstructionBlock("repo:y", "statewave"));
    expect(twice.match(/statewave:begin/g)?.length).toBe(1);
    expect(twice).toContain("repo:y");
    expect(twice).not.toContain("repo:x");
  });
});

describe("mcp init command", () => {
  it("lists supported clients when none is given", async () => {
    const { buf, restore } = captureStdout();
    const code = await main(["mcp", "init"]);
    restore();
    expect(code).toBe(0);
    const out = buf.join("");
    expect(out).toContain("claude");
    expect(out).toContain("codex");
  });

  it("returns exit code 2 on an unknown client", async () => {
    const stdout = captureStdout();
    const errBuf: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      errBuf.push(String(c));
      return true;
    });
    const code = await main(["mcp", "init", "emacs"]);
    stdout.restore();
    errSpy.mockRestore();
    expect(code).toBe(2);
    expect(errBuf.join("")).toContain("unknown client: emacs");
  });

  it("prints the config + instruction blocks and writes nothing by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-init-"));
    const prev = process.cwd();
    process.chdir(dir);
    const { buf, restore } = captureStdout();
    const code = await main(["mcp", "init", "claude"]);
    restore();
    process.chdir(prev);
    expect(code).toBe(0);
    const out = buf.join("");
    expect(out).toContain("mcpServers");
    expect(out).toContain("Nothing was written");
    // confirm it really wrote nothing
    await expect(readFile(join(dir, ".mcp.json"), "utf8")).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it("--write merges into an existing .mcp.json and writes CLAUDE.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-init-"));
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const prev = process.cwd();
    process.chdir(dir);
    const { restore } = captureStdout();
    const code = await main(["mcp", "init", "claude", "--subject", "repo:acme", "--write"]);
    restore();
    process.chdir(prev);
    expect(code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    expect(cfg.mcpServers.other.command).toBe("x");
    expect(cfg.mcpServers.statewave.args).toEqual(["-y", MCP_SERVER_PACKAGE]);
    const instr = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(instr).toContain("repo:acme");
    await rm(dir, { recursive: true, force: true });
  });
});
