import { describe, it, expect } from "vitest";
import {
  resolveEditorCli,
  editorIdentity,
  installAndVerify,
  isEditorClient,
  EXTENSION_ID,
  type InstallDeps,
} from "../src/commands/extensions.js";

describe("resolveEditorCli (cross-platform)", () => {
  it("prefers the macOS app bundle over PATH", () => {
    const bundle = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    const cli = resolveEditorCli("vscode", { platform: "darwin", exists: (p) => p === bundle, pathDirs: ["/usr/local/bin"] });
    expect(cli).toBe(bundle);
  });
  it("resolves the Windows install path", () => {
    const exists = (p: string) => p.includes("Microsoft VS Code") && p.endsWith("code.cmd");
    const cli = resolveEditorCli("vscode", { platform: "win32", exists, pathDirs: [] });
    expect(cli).toMatch(/Microsoft VS Code.*code\.cmd$/);
  });
  it("resolves a Linux install path", () => {
    const cli = resolveEditorCli("vscode", { platform: "linux", exists: (p) => p === "/usr/share/code/bin/code", pathDirs: [] });
    expect(cli).toBe("/usr/share/code/bin/code");
  });
  it("falls back to PATH when no bundle exists", () => {
    const cli = resolveEditorCli("cursor", { platform: "linux", exists: (p) => p === "/home/u/bin/cursor", pathDirs: ["/home/u/bin"] });
    expect(cli).toBe("/home/u/bin/cursor");
  });
  it("returns undefined when nothing resolves / for non-editors", () => {
    expect(resolveEditorCli("vscode", { platform: "linux", exists: () => false, pathDirs: ["/x"] })).toBeUndefined();
    expect(resolveEditorCli("codex", {})).toBeUndefined();
    expect(isEditorClient("claude")).toBe(false);
    expect(isEditorClient("cursor")).toBe(true);
  });
});

describe("editorIdentity", () => {
  it("names the editor a `code` path actually resolves to", () => {
    expect(editorIdentity("/Applications/Cursor.app/Contents/Resources/app/bin/code")).toBe("Cursor");
    expect(editorIdentity("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")).toBe("VS Code");
  });
});

describe("installAndVerify — the 8-case matrix", () => {
  const base = (over: Partial<InstallDeps>): InstallDeps => ({
    resolve: () => "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    realpath: (p) => p,
    list: () => new Set<string>(),
    install: () => ({ ok: true, message: "ok" }),
    ...over,
  });

  it("1+4. app + CLI available, fresh install succeeds and verifies", () => {
    let installed = false;
    const r = installAndVerify("vscode", EXTENSION_ID, base({
      list: () => (installed ? new Set([EXTENSION_ID.toLowerCase()]) : new Set()),
      install: () => { installed = true; return { ok: true, message: "ok" }; },
    }));
    expect(r.status).toBe("installed");
    expect(r.via).toBe("VS Code");
  });

  it("2. CLI not found → no-cli (never claims installed)", () => {
    const r = installAndVerify("vscode", EXTENSION_ID, base({ resolve: () => undefined }));
    expect(r.status).toBe("no-cli");
  });

  it("3. extension already installed → already (no reinstall)", () => {
    let installCalls = 0;
    const r = installAndVerify("vscode", EXTENSION_ID, base({
      list: () => new Set([EXTENSION_ID.toLowerCase()]),
      install: () => { installCalls++; return { ok: true, message: "ok" }; },
    }));
    expect(r.status).toBe("already");
    expect(installCalls).toBe(0);
  });

  it("5+6+7. install command fails (registry down / unsupported version) → failed, not success", () => {
    const r = installAndVerify("vscode", EXTENSION_ID, base({
      install: () => ({ ok: false, message: "Failed Installing Extensions: connection refused" }),
    }));
    expect(r.status).toBe("failed");
    expect(r.message).toContain("Failed Installing");
  });

  it("install exits 0 but extension is NOT present → unverified (the real bug)", () => {
    const r = installAndVerify("vscode", EXTENSION_ID, base({
      list: () => new Set(), // never shows up even after a 'successful' install
      install: () => ({ ok: true, message: "ok" }),
    }));
    expect(r.status).toBe("unverified");
  });

  it("--extension-vsix reinstalls even when already present → updated", () => {
    const r = installAndVerify("vscode", EXTENSION_ID, base({
      vsixGiven: true,
      list: () => new Set([EXTENSION_ID.toLowerCase()]),
    }));
    expect(r.status).toBe("updated");
  });

  it("8. Cursor and VS Code resolve to distinct binaries (caller dedups)", () => {
    const code = installAndVerify("vscode", EXTENSION_ID, base({
      resolve: () => "/Applications/Cursor.app/Contents/Resources/app/bin/code", // code → Cursor shim
      list: () => new Set([EXTENSION_ID.toLowerCase()]),
    }));
    const cursor = installAndVerify("cursor", EXTENSION_ID, base({
      resolve: () => "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      list: () => new Set([EXTENSION_ID.toLowerCase()]),
    }));
    expect(code.via).toBe("Cursor");
    expect(cursor.via).toBe("Cursor");
    expect(code.binary).not.toBe(cursor.binary);
  });
});
