import { describe, it, expect } from "vitest";
import { resolveActiveClients, editorKind } from "../src/index.js";

describe("editorKind", () => {
  it("classifies by uri scheme then app name", () => {
    expect(editorKind("vscode", "Visual Studio Code")).toBe("vscode");
    expect(editorKind("vscode-insiders", "Visual Studio Code - Insiders")).toBe("vscode");
    expect(editorKind("cursor", "Cursor")).toBe("cursor");
    expect(editorKind("windsurf", "Windsurf")).toBe("windsurf");
    expect(editorKind("x", "Cursor")).toBe("cursor"); // app-name fallback
    expect(editorKind("x", "Some Editor")).toBe("other");
  });
});

describe("resolveActiveClients", () => {
  const none = {
    editor: "vscode" as const,
    hasCopilot: false,
    hasClaudeCode: false,
    hasCline: false,
    hasRoo: false,
    hasContinue: false,
    hasCodex: false,
  };

  it("plain VS Code + Copilot → only copilot (no cursor/windsurf/etc.)", () => {
    expect(resolveActiveClients({ ...none, hasCopilot: true })).toEqual(["copilot"]);
  });

  it("does not include cursor/windsurf unless that is the editor", () => {
    const r = resolveActiveClients({ ...none, hasCopilot: true, hasClaudeCode: true });
    expect(r).toContain("copilot");
    expect(r).toContain("claude");
    expect(r).not.toContain("cursor");
    expect(r).not.toContain("windsurf");
  });

  it("Cursor editor → cursor; Windsurf editor → windsurf", () => {
    expect(resolveActiveClients({ ...none, editor: "cursor" })).toEqual(["cursor"]);
    expect(resolveActiveClients({ ...none, editor: "windsurf" })).toEqual(["windsurf"]);
  });

  it("extensions/CLIs are independent of the editor", () => {
    const r = resolveActiveClients({
      editor: "cursor",
      hasCopilot: false,
      hasClaudeCode: true,
      hasCline: true,
      hasRoo: true,
      hasContinue: true,
      hasCodex: true,
    });
    expect(r.sort()).toEqual([
      "claude",
      "cline",
      "codex",
      "continue",
      "cursor",
      "roo",
    ]);
  });

  it("detects codex on its own signal", () => {
    expect(resolveActiveClients({ ...none, hasCodex: true })).toEqual(["codex"]);
  });

  it("nothing detected → empty (writes no instruction files)", () => {
    expect(resolveActiveClients(none)).toEqual([]);
  });
});
