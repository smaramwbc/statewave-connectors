import { describe, it, expect } from "vitest";
import {
  nextProbeDelayMs,
  readyzUrl,
  OFFLINE_PROBE_MS,
  ONLINE_HEARTBEAT_MS,
} from "../src/index.js";

describe("nextProbeDelayMs", () => {
  it("heartbeats slowly when online", () => {
    expect(nextProbeDelayMs(true)).toBe(ONLINE_HEARTBEAT_MS);
  });

  it("probes quickly when offline", () => {
    expect(nextProbeDelayMs(false)).toBe(OFFLINE_PROBE_MS);
  });

  it("probes quickly when state is unknown (never checked yet)", () => {
    expect(nextProbeDelayMs(undefined)).toBe(OFFLINE_PROBE_MS);
  });

  it("offline cadence is much faster than the online heartbeat", () => {
    expect(OFFLINE_PROBE_MS).toBeLessThan(ONLINE_HEARTBEAT_MS);
  });
});

describe("readyzUrl", () => {
  it("appends /readyz to a bare base URL", () => {
    expect(readyzUrl("http://localhost:8100")).toBe("http://localhost:8100/readyz");
  });

  it("normalises a single trailing slash", () => {
    expect(readyzUrl("http://localhost:8100/")).toBe("http://localhost:8100/readyz");
  });

  it("normalises multiple trailing slashes (no double slash before readyz)", () => {
    expect(readyzUrl("https://sw.example.com///")).toBe(
      "https://sw.example.com/readyz",
    );
  });

  it("targets /readyz, not the bare root (which 404s and only proves the port is open)", () => {
    expect(readyzUrl("http://host:9000")).toMatch(/\/readyz$/);
  });
});
