import { describe, it, expect, vi } from "vitest";
import { withRetry, ConnectorError } from "../src/index.js";

describe("withRetry", () => {
  it("returns the value on the first successful call", async () => {
    const fn = vi.fn(async () => 42);
    const v = await withRetry(fn, { retries: 3, baseDelayMs: 1, jitter: false });
    expect(v).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until success when error is retryable", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new ConnectorError("temporary", { code: "network" });
      }
      return "ok";
    });
    const v = await withRetry(fn, { retries: 5, baseDelayMs: 1, jitter: false });
    expect(v).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable ConnectorError", async () => {
    const fn = vi.fn(async () => {
      throw new ConnectorError("bad config", { code: "config_invalid" });
    });
    await expect(withRetry(fn, { retries: 5, baseDelayMs: 1, jitter: false })).rejects.toThrow(
      "bad config",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects custom shouldRetry", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      withRetry(fn, { retries: 5, baseDelayMs: 1, jitter: false, shouldRetry: () => false }),
    ).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
