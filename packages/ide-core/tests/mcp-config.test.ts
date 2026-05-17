import { describe, it, expect } from "vitest";
import {
  buildStdioEntry,
  mergeCursorConfig,
  mergeVscodeMcpConfig,
  STATEWAVE_MCP_KEY,
} from "../src/index.js";

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
