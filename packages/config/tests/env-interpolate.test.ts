import { describe, it, expect } from "vitest";
import { interpolate } from "../src/env-interpolate.js";

describe("interpolate", () => {
  it("replaces ${VAR} with the env value", () => {
    const node: Record<string, unknown> = { url: "${BASE}/v1" };
    const { missing } = interpolate(node, { BASE: "https://api.example.com" });
    expect(node.url).toBe("https://api.example.com/v1");
    expect(missing).toEqual([]);
  });

  it("walks nested arrays + objects", () => {
    const node = {
      list: ["${A}", "${B}"],
      nested: { inner: "${A}-${B}" },
    };
    const { missing } = interpolate(node, { A: "1", B: "2" });
    expect(node.list).toEqual(["1", "2"]);
    expect(node.nested.inner).toBe("1-2");
    expect(missing).toEqual([]);
  });

  it("collects missing required vars without throwing", () => {
    const node = { token: "${MISSING_TOKEN}", other: "${ALSO_MISSING}" };
    const { missing } = interpolate(node, {});
    expect(new Set(missing)).toEqual(new Set(["MISSING_TOKEN", "ALSO_MISSING"]));
  });

  it("uses ${VAR:-fallback} when var is unset", () => {
    const node = { v: "${UNSET:-fallback}" };
    const { missing } = interpolate(node, {});
    expect(node.v).toBe("fallback");
    expect(missing).toEqual([]);
  });

  it("uses ${VAR:-fallback} when var is empty string", () => {
    const node = { v: "${EMPTY:-fallback}" };
    const { missing } = interpolate(node, { EMPTY: "" });
    expect(node.v).toBe("fallback");
    expect(missing).toEqual([]);
  });

  it("$$ escapes a literal $ before { (does not get interpolated)", () => {
    const node = { v: "$${LITERAL}" };
    const { missing } = interpolate(node, { LITERAL: "expanded" });
    expect(node.v).toBe("${LITERAL}");
    expect(missing).toEqual([]);
  });

  it("leaves the placeholder verbatim when missing (so partial expansion can't pass for valid)", () => {
    const node = { v: "prefix-${MISSING}-suffix" };
    interpolate(node, {});
    expect(node.v).toBe("prefix-${MISSING}-suffix");
  });

  it("ignores non-string values (numbers, booleans pass through)", () => {
    const node = { port: 3000, accept: true, list: [1, 2, 3] };
    const { missing } = interpolate(node, {});
    expect(node).toEqual({ port: 3000, accept: true, list: [1, 2, 3] });
    expect(missing).toEqual([]);
  });
});
