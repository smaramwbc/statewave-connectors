import { describe, it, expect } from "vitest";
import { parseArgs, flagAsBool, flagAsList, flagAsString, flagAsInt } from "../src/args.js";

describe("parseArgs", () => {
  it("collects positionals and value flags", () => {
    const a = parseArgs(["sync", "github", "--repo", "acme/widgets", "--dry-run"]);
    expect(a.positional).toEqual(["sync", "github"]);
    expect(flagAsString(a, "repo")).toBe("acme/widgets");
    expect(flagAsBool(a, "dry-run")).toBe(true);
  });

  it("supports --key=value", () => {
    const a = parseArgs(["--subject=repo:acme/widgets"]);
    expect(flagAsString(a, "subject")).toBe("repo:acme/widgets");
  });

  it("parses comma-separated lists", () => {
    const a = parseArgs(["--include", "issues,prs"]);
    expect(flagAsList(a, "include")).toEqual(["issues", "prs"]);
  });

  it("parses ints", () => {
    const a = parseArgs(["--max-items", "50"]);
    expect(flagAsInt(a, "max-items")).toBe(50);
  });
});
