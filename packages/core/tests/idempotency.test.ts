import { describe, it, expect } from "vitest";
import { idempotencyKey, namespacedKey } from "../src/index.js";

describe("idempotencyKey", () => {
  it("is deterministic and short", () => {
    const k1 = idempotencyKey(["github", "issue", 42]);
    const k2 = idempotencyKey(["github", "issue", 42]);
    expect(k1).toBe(k2);
    expect(k1).toHaveLength(32);
  });

  it("changes when any part changes", () => {
    expect(idempotencyKey(["a", "b"])).not.toBe(idempotencyKey(["a", "c"]));
    expect(idempotencyKey(["a", "b"])).not.toBe(idempotencyKey(["a", "b", "c"]));
  });

  it("treats null and undefined as empty without colliding with other content", () => {
    const a = idempotencyKey(["a", null, "b"]);
    const b = idempotencyKey(["a", undefined, "b"]);
    expect(a).toBe(b);
  });

  it("namespacedKey prefixes the namespace", () => {
    const k = namespacedKey("github", "issue", 1);
    expect(k.startsWith("github:")).toBe(true);
  });
});
