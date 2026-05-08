import { describe, it, expect } from "vitest";
import { ConnectorError } from "../src/index.js";

describe("ConnectorError", () => {
  it("defaults retryable based on code", () => {
    expect(new ConnectorError("x", { code: "rate_limited" }).retryable).toBe(true);
    expect(new ConnectorError("x", { code: "network" }).retryable).toBe(true);
    expect(new ConnectorError("x", { code: "auth_failed" }).retryable).toBe(false);
    expect(new ConnectorError("x", { code: "config_invalid" }).retryable).toBe(false);
  });

  it("serializes to JSON with stable shape", () => {
    const e = new ConnectorError("nope", {
      code: "auth_missing",
      connector: "github",
      hint: "set GITHUB_TOKEN",
    });
    const j = e.toJSON();
    expect(j).toMatchObject({
      name: "ConnectorError",
      message: "nope",
      code: "auth_missing",
      connector: "github",
      hint: "set GITHUB_TOKEN",
      retryable: false,
    });
  });
});
