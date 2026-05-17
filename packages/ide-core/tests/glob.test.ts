import { describe, it, expect } from "vitest";
import { matchesGlob, matchesAnyGlob } from "../src/index.js";

describe("matchesGlob", () => {
  it("matches a single path segment with *", () => {
    expect(matchesGlob("src/index.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/sub/index.ts", "src/*.ts")).toBe(false);
  });

  it("matches across segments with **", () => {
    expect(matchesGlob("docs/adr/0001.md", "docs/**/*.md")).toBe(true);
    expect(matchesGlob("docs/0001.md", "docs/**/*.md")).toBe(true);
    expect(matchesGlob("src/a.ts", "docs/**/*.md")).toBe(false);
  });

  it("supports ? for a single char", () => {
    expect(matchesGlob("a1.ts", "a?.ts")).toBe(true);
    expect(matchesGlob("a12.ts", "a?.ts")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    expect(matchesGlob("a+b.txt", "a+b.txt")).toBe(true);
    expect(matchesGlob("axb.txt", "a+b.txt")).toBe(false);
  });

  it("matchesAnyGlob ORs the patterns", () => {
    expect(matchesAnyGlob("dist/keep/x.js", ["dist/keep/**", "build/**"])).toBe(true);
    expect(matchesAnyGlob("node_modules/x", ["dist/keep/**"])).toBe(false);
  });
});
