import { describe, it, expect } from "vitest";
import { envSetupHint } from "../src/env.js";

describe("envSetupHint", () => {
  it("gives zsh export + ~/.zshrc on macOS with a zsh shell", () => {
    const hint = envSetupHint({ SHELL: "/bin/zsh" }, "darwin");
    expect(hint).toContain("macOS / Linux");
    expect(hint).toContain('export STATEWAVE_URL="http://localhost:8100"');
    expect(hint).toContain("~/.zshrc");
  });

  it("uses ~/.bashrc for a bash shell", () => {
    expect(envSetupHint({ SHELL: "/bin/bash" }, "linux")).toContain("~/.bashrc");
  });

  it("gives PowerShell / setx / set on Windows", () => {
    const hint = envSetupHint({}, "win32");
    expect(hint).toContain("Windows");
    expect(hint).toContain("$env:STATEWAVE_URL");
    expect(hint).toContain("setx STATEWAVE_URL");
    expect(hint).toContain("set STATEWAVE_URL=");
  });
});
