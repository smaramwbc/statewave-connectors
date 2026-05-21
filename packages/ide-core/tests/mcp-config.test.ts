import { describe, it, expect } from "vitest";
import {
  buildStdioEntry,
  mergeMcpServersConfig,
  mergeCursorConfig,
  mergeVscodeMcpConfig,
  mergeClaudeProjectConfig,
  removeMcpServer,
  removeClaudeProjectServer,
  renderContinueYaml,
  renderCodexTomlBlock,
  mergeCodexToml,
  STATEWAVE_MCP_KEY,
} from "../src/index.js";

describe("Codex config.toml merge", () => {
  const e = buildStdioEntry({
    command: "node",
    serverScriptPath: "/ext/dist/mcp-stdio.cjs",
    url: "http://localhost:8100",
    apiKey: "k",
  });

  it("renders a valid [mcp_servers.statewave] table", () => {
    const b = renderCodexTomlBlock(e);
    expect(b).toContain("[mcp_servers.statewave]");
    expect(b).toContain('command = "node"');
    expect(b).toContain('args = ["/ext/dist/mcp-stdio.cjs"]');
    expect(b).toContain('STATEWAVE_URL = "http://localhost:8100"');
    expect(b).toContain('STATEWAVE_API_KEY = "k"');
  });

  it("appends the table to an existing config, preserving other tables", () => {
    const existing = '[model]\nname = "gpt-5"\n\n[other]\nx = 1\n';
    const { content, changed } = mergeCodexToml(existing, e);
    expect(changed).toBe(true);
    expect(content).toContain('[model]');
    expect(content).toContain('[other]');
    expect(content).toContain("[mcp_servers.statewave]");
  });

  it("replaces only our table on update; idempotent", () => {
    const first = mergeCodexToml('[model]\nname = "gpt-5"\n', e).content;
    const other = buildStdioEntry({
      command: "node",
      serverScriptPath: "/ext/dist/mcp-stdio.cjs",
      url: "http://localhost:9999",
    });
    const second = mergeCodexToml(first, other);
    expect(second.changed).toBe(true);
    expect(second.content).toContain("localhost:9999");
    expect(second.content).not.toContain("localhost:8100");
    expect(second.content).toContain('[model]'); // user table untouched
    // a trailing table after ours is preserved across replacement
    const withTail = mergeCodexToml(first + "\n[zzz]\nq = 2\n", e).content;
    expect(withTail).toContain("[zzz]");
    expect(mergeCodexToml(withTail, e).changed).toBe(false);
  });

  it("handles an empty/absent file", () => {
    const r = mergeCodexToml("", e);
    expect(r.changed).toBe(true);
    expect(r.content).toContain("[mcp_servers.statewave]");
  });
});

describe("reset removers", () => {
  const e = buildStdioEntry({ command: "node", serverScriptPath: "/s.cjs", url: "u" });
  it("removeMcpServer drops only our key, preserves others, idempotent", () => {
    const merged = mergeMcpServersConfig({ mcpServers: { other: { command: "x" } } }, e).config;
    const r = removeMcpServer(merged);
    expect(r.changed).toBe(true);
    expect((r.config as any).mcpServers.other).toEqual({ command: "x" });
    expect((r.config as any).mcpServers[STATEWAVE_MCP_KEY]).toBeUndefined();
    expect(removeMcpServer(r.config).changed).toBe(false);
  });
  it("removeClaudeProjectServer drops our key under the project only", () => {
    const merged = mergeClaudeProjectConfig(
      { projects: { "/p": { mcpServers: { keep: { command: "k" } } } } },
      "/p",
      e,
    ).config;
    const r = removeClaudeProjectServer(merged, "/p");
    expect(r.changed).toBe(true);
    expect((r.config as any).projects["/p"].mcpServers.keep).toEqual({ command: "k" });
    expect((r.config as any).projects["/p"].mcpServers[STATEWAVE_MCP_KEY]).toBeUndefined();
    expect(removeClaudeProjectServer(r.config, "/p").changed).toBe(false);
  });
});

describe("buildStdioEntry", () => {
  it("puts connection info in env, key only when present", () => {
    const withKey = buildStdioEntry({
      command: "node",
      serverScriptPath: "/ext/dist/mcp-stdio.cjs",
      url: "http://localhost:8100",
      apiKey: "secret",
    });
    expect(withKey.command).toBe("node");
    expect(withKey.args).toEqual(["/ext/dist/mcp-stdio.cjs"]);
    expect(withKey.env).toEqual({
      STATEWAVE_URL: "http://localhost:8100",
      STATEWAVE_API_KEY: "secret",
    });

    const noKey = buildStdioEntry({
      command: "node",
      serverScriptPath: "/s.cjs",
      url: "http://localhost:8100",
    });
    expect(noKey.env).toEqual({ STATEWAVE_URL: "http://localhost:8100" });
    expect("STATEWAVE_API_KEY" in noKey.env).toBe(false);
  });
});

const entry = buildStdioEntry({
  command: "node",
  serverScriptPath: "/s.cjs",
  url: "http://localhost:8100",
  apiKey: "k",
});

describe("mergeCursorConfig", () => {
  it("adds our server and preserves unrelated servers", () => {
    const { config, changed } = mergeCursorConfig(
      { mcpServers: { other: { command: "x" } }, somethingElse: 1 },
      entry,
    );
    expect(changed).toBe(true);
    const servers = (config as any).mcpServers;
    expect(servers.other).toEqual({ command: "x" });
    expect(servers[STATEWAVE_MCP_KEY]).toEqual({
      command: "node",
      args: ["/s.cjs"],
      env: { STATEWAVE_URL: "http://localhost:8100", STATEWAVE_API_KEY: "k" },
    });
    expect((config as any).somethingElse).toBe(1);
  });

  it("is idempotent — no change when already identical", () => {
    const first = mergeCursorConfig({}, entry);
    expect(first.changed).toBe(true);
    const second = mergeCursorConfig(first.config, entry);
    expect(second.changed).toBe(false);
  });

  it("reports changed when our entry differs", () => {
    const first = mergeCursorConfig({}, entry).config;
    const other = buildStdioEntry({
      command: "node",
      serverScriptPath: "/s.cjs",
      url: "http://localhost:9999",
    });
    expect(mergeCursorConfig(first, other).changed).toBe(true);
  });

  it("tolerates a non-object / corrupt existing file", () => {
    expect(mergeCursorConfig(null, entry).changed).toBe(true);
    expect(mergeCursorConfig("garbage", entry).changed).toBe(true);
    expect(mergeCursorConfig(42, entry).config).toHaveProperty("mcpServers");
  });
});

describe("mergeVscodeMcpConfig", () => {
  it("uses the .vscode/mcp.json shape (servers + type:stdio)", () => {
    const { config } = mergeVscodeMcpConfig({}, entry);
    expect((config as any).servers[STATEWAVE_MCP_KEY]).toEqual({
      type: "stdio",
      command: "node",
      args: ["/s.cjs"],
      env: { STATEWAVE_URL: "http://localhost:8100", STATEWAVE_API_KEY: "k" },
    });
  });

  it("preserves other servers and is idempotent", () => {
    const a = mergeVscodeMcpConfig(
      { servers: { keep: { type: "stdio", command: "y" } } },
      entry,
    );
    expect((a.config as any).servers.keep).toEqual({
      type: "stdio",
      command: "y",
    });
    const b = mergeVscodeMcpConfig(a.config, entry);
    expect(b.changed).toBe(false);
  });
});

describe("mergeClaudeProjectConfig", () => {
  const proj = "/abs/project";

  it("nests under projects[path].mcpServers with type:stdio", () => {
    const { config } = mergeClaudeProjectConfig({}, proj, entry);
    expect(
      (config as any).projects[proj].mcpServers[STATEWAVE_MCP_KEY],
    ).toEqual({
      type: "stdio",
      command: "node",
      args: ["/s.cjs"],
      env: { STATEWAVE_URL: "http://localhost:8100", STATEWAVE_API_KEY: "k" },
    });
  });

  it("preserves the rest of ~/.claude.json (other keys, projects, servers)", () => {
    const existing = {
      numStartups: 7,
      projects: {
        "/other/proj": { mcpServers: { foo: { command: "f" } } },
        [proj]: {
          allowedTools: ["Bash"],
          mcpServers: { keepme: { type: "stdio", command: "k" } },
        },
      },
    };
    const { config, changed } = mergeClaudeProjectConfig(existing, proj, entry);
    expect(changed).toBe(true);
    const c = config as any;
    expect(c.numStartups).toBe(7);
    expect(c.projects["/other/proj"]).toEqual({
      mcpServers: { foo: { command: "f" } },
    });
    expect(c.projects[proj].allowedTools).toEqual(["Bash"]);
    expect(c.projects[proj].mcpServers.keepme).toEqual({
      type: "stdio",
      command: "k",
    });
    expect(c.projects[proj].mcpServers[STATEWAVE_MCP_KEY]).toBeDefined();
  });

  it("is idempotent for the same project + entry", () => {
    const a = mergeClaudeProjectConfig({}, proj, entry);
    expect(a.changed).toBe(true);
    const b = mergeClaudeProjectConfig(a.config, proj, entry);
    expect(b.changed).toBe(false);
  });
});

describe("mergeMcpServersConfig (Cursor/Windsurf/Cline/Roo shared)", () => {
  it("is the same function as the mergeCursorConfig alias", () => {
    expect(mergeMcpServersConfig).toBe(mergeCursorConfig);
  });
  it("merges + is idempotent (covers Windsurf/Cline/Roo too)", () => {
    const a = mergeMcpServersConfig({ mcpServers: { keep: { command: "x" } } }, entry);
    expect((a.config as any).mcpServers.keep).toEqual({ command: "x" });
    expect((a.config as any).mcpServers[STATEWAVE_MCP_KEY].command).toBe("node");
    expect(mergeMcpServersConfig(a.config, entry).changed).toBe(false);
  });
});

describe("renderContinueYaml", () => {
  const y = renderContinueYaml(entry);

  it("emits a valid standalone file with required metadata", () => {
    expect(y.file).toContain("name: Statewave Project Memory");
    expect(y.file).toContain("version: 0.0.1");
    expect(y.file).toContain("schema: v1");
    expect(y.file).toContain("mcpServers:");
    expect(y.file).toContain("type: stdio");
  });

  it("quotes scalars and includes env (key stays in env, not args)", () => {
    expect(y.snippet).toContain('command: "node"');
    expect(y.snippet).toContain('- "/s.cjs"');
    expect(y.snippet).toContain('STATEWAVE_URL: "http://localhost:8100"');
    expect(y.snippet).toContain('STATEWAVE_API_KEY: "k"');
    // snippet is the mcpServers block only (for pasting into existing config)
    expect(y.snippet.startsWith("mcpServers:")).toBe(true);
    expect(y.file).toContain(y.snippet);
  });

  it("escapes embedded quotes/backslashes in values", () => {
    const e = buildStdioEntry({
      command: "node",
      serverScriptPath: 'C:\\Program Files\\x "y".cjs',
      url: "http://localhost:8100",
    });
    const r = renderContinueYaml(e);
    expect(r.snippet).toContain('"C:\\\\Program Files\\\\x \\"y\\".cjs"');
  });
});
