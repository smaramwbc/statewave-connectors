import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The bootstrap scripts live at the repo root (served by raw URL / the website),
// upstream of the published package — they get Node, then hand off to npx. They
// can't be unit-tested like TS, but their SAFETY CONTRACT must not silently
// regress: official source only, checksum-verified, consent-gated, and never
// claiming success without a post-install `node --version`. These tests pin
// exactly those properties.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sh = readFileSync(resolve(root, "scripts/bootstrap.sh"), "utf8");
const ps1 = readFileSync(resolve(root, "scripts/bootstrap.ps1"), "utf8");

describe("bootstrap.sh contract", () => {
  it("is valid POSIX shell (sh -n)", () => {
    expect(() => execFileSync("sh", ["-n", resolve(root, "scripts/bootstrap.sh")])).not.toThrow();
  });

  it("only fetches Node from the official nodejs.org distribution", () => {
    expect(sh).toContain("nodejs.org/dist");
    // no third-party / unpinned mirrors
    expect(sh).not.toMatch(/curl[^\n]*http:\/\//); // never plain-HTTP a download
  });

  it("verifies the download against the published SHA-256 and aborts on mismatch", () => {
    expect(sh).toContain("SHASUMS256.txt");
    expect(sh).toMatch(/shasum -a 256|sha256sum/);
    expect(sh).toContain("checksum mismatch");
  });

  it("never installs without consent (prompt, or --yes; refuses non-interactive)", () => {
    expect(sh).toContain("ASSUME_YES");
    expect(sh).toContain("Non-interactive shell");
  });

  it("installs into a user-local prefix (never invokes sudo)", () => {
    expect(sh).toContain("$HOME/.statewave");
    expect(sh).not.toMatch(/\bsudo\s+[\w./-]/); // no `sudo <command>` invocation
  });

  it("verifies Node actually runs before handing off", () => {
    // a node_major check guards the success line and the handoff
    expect(sh).toContain("node_major");
    expect(sh).toContain("exec npx -y");
  });
});

describe("bootstrap.ps1 contract", () => {
  it("only fetches Node from the official nodejs.org distribution", () => {
    expect(ps1).toContain("nodejs.org/dist");
  });

  it("verifies the download against the published SHA-256 and aborts on mismatch", () => {
    expect(ps1).toContain("SHASUMS256.txt");
    expect(ps1).toContain("Get-FileHash");
    expect(ps1).toContain("checksum mismatch");
  });

  it("never installs without consent (-Yes; refuses non-interactive)", () => {
    expect(ps1).toContain("$Yes");
    expect(ps1).toContain("Non-interactive shell");
  });

  it("installs into a user-local prefix and verifies Node before handoff", () => {
    expect(ps1).toContain(".statewave");
    expect(ps1).toContain("NodeMajor");
    expect(ps1).toContain("npx -y");
  });
});
