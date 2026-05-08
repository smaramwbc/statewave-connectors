import { describe, it, expect, vi, afterEach } from "vitest";
import { main } from "../src/index.js";

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

describe("CLI help and version", () => {
  it("prints root help with no args", async () => {
    const { buf, restore } = captureStdout();
    const code = await main([]);
    restore();
    expect(code).toBe(0);
    expect(buf.join("")).toMatch(/statewave-connectors v\d+\.\d+\.\d+/);
    expect(buf.join("")).toContain("commands:");
  });

  it("prints version on --version", async () => {
    const { buf, restore } = captureStdout();
    const code = await main(["--version"]);
    restore();
    expect(code).toBe(0);
    expect(buf.join("").trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints per-command help for `sync --help`", async () => {
    const { buf, restore } = captureStdout();
    const code = await main(["sync", "--help"]);
    restore();
    expect(code).toBe(0);
    const out = buf.join("");
    expect(out).toContain("statewave-connectors sync");
    expect(out).toContain("--dry-run");
    expect(out).toContain("--include");
  });

  it("prints per-command help for `help mcp`", async () => {
    const { buf, restore } = captureStdout();
    const code = await main(["help", "mcp"]);
    restore();
    expect(code).toBe(0);
    expect(buf.join("")).toContain("Statewave MCP server");
  });

  it("returns exit code 2 on unknown command", async () => {
    const stdout = captureStdout();
    const stderrBuf: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    const code = await main(["frobnicate"]);
    stdout.restore();
    stderrSpy.mockRestore();
    expect(code).toBe(2);
    expect(stderrBuf.join("")).toContain("unknown command: frobnicate");
  });
});
