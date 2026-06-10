import { describe, it, expect } from "vitest";
import { diffSymbolSets, isEmptyDiff } from "../src/symbol-diff.js";

describe("diffSymbolSets", () => {
  it("flags a pure add", () => {
    const d = diffSymbolSets(
      [{ name: "a", kind: "function", line: 1 }],
      [
        { name: "a", kind: "function", line: 1 },
        { name: "b", kind: "function", line: 10 },
      ],
    );
    expect(d.added.map((s) => s.name)).toEqual(["b"]);
    expect(d.removed).toEqual([]);
    expect(d.moved).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it("flags a pure remove", () => {
    const d = diffSymbolSets(
      [
        { name: "a", kind: "function", line: 1 },
        { name: "b", kind: "function", line: 10 },
      ],
      [{ name: "a", kind: "function", line: 1 }],
    );
    expect(d.removed.map((s) => s.name)).toEqual(["b"]);
    expect(d.added).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it("treats same name + different kind as separate symbols", () => {
    const d = diffSymbolSets(
      [{ name: "User", kind: "class", line: 1 }],
      [{ name: "User", kind: "function", line: 1 }],
    );
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
  });

  it("flags a move when the line changed for the same (name, kind)", () => {
    const d = diffSymbolSets(
      [{ name: "verify", kind: "function", line: 12 }],
      [{ name: "verify", kind: "function", line: 42 }],
    );
    expect(d.moved).toEqual([
      { name: "verify", kind: "function", from: 12, to: 42 },
    ]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unchanged).toBe(0);
  });

  it("does not flag a move when the line metadata is missing", () => {
    const d = diffSymbolSets(
      [{ name: "verify", kind: "function" }],
      [{ name: "verify", kind: "function" }],
    );
    expect(d.moved).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it("returns an empty diff for identical lists (so the caller can skip)", () => {
    const list = [
      { name: "a", kind: "function", line: 1 },
      { name: "b", kind: "class", line: 50 },
    ];
    const d = diffSymbolSets(list, list);
    expect(isEmptyDiff(d)).toBe(true);
    expect(d.unchanged).toBe(2);
  });

  it("handles the from-empty case (file just got symbols)", () => {
    const d = diffSymbolSets([], [{ name: "a", kind: "function", line: 1 }]);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toEqual([]);
  });

  it("handles the to-empty case (file lost all symbols / deleted)", () => {
    const d = diffSymbolSets([{ name: "a", kind: "function", line: 1 }], []);
    expect(d.added).toEqual([]);
    expect(d.removed).toHaveLength(1);
  });
});
