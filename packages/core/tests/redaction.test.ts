import { describe, it, expect } from "vitest";
import { redact } from "../src/index.js";

describe("redact", () => {
  it("returns input unchanged when no options provided", () => {
    expect(redact("hello world")).toBe("hello world");
  });

  it("redacts emails when enabled", () => {
    const out = redact("ping me at ada@example.com", { email: true });
    expect(out).not.toContain("ada@example.com");
    expect(out).toContain("[redacted:email]");
  });

  it("redacts phone numbers when enabled", () => {
    const out = redact("call +1 (415) 555-2671 today", { phone: true });
    expect(out).toContain("[redacted:phone]");
  });

  it("redacts known secret patterns when enabled", () => {
    const samples = [
      "ghp_abcdefghijklmnopqrstuvwxyz12345",
      "sk-ant-abcdefghijklmnopqrstuvwxyz",
      "AKIAABCDEFGHIJKLMNOP",
    ];
    for (const s of samples) {
      const out = redact(`token=${s}`, { secrets: true });
      expect(out).not.toContain(s);
    }
  });

  it("applies custom rules", () => {
    const out = redact("internal-id=12345", {
      rules: [{ name: "internal-id", pattern: /\d{5}/g }],
    });
    expect(out).toContain("[redacted:internal-id]");
  });
});
