import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { formatZapToEpisode, type ZapEpisodeInput } from "../src/index.js";

const baseInput: ZapEpisodeInput = {
  subject: "workflow:zap:12345",
  zap_id: "12345",
  zap_name: "Daily Slack digest",
  run_id: "67890",
  status: "success",
};

describe("formatZapToEpisode", () => {
  it("maps a successful run to zapier.zap.executed", () => {
    const ep = formatZapToEpisode(baseInput);
    expect(ep.subject).toBe("workflow:zap:12345");
    expect(ep.kind).toBe("zapier.zap.executed");
    expect(ep.text).toContain("Daily Slack digest");
    expect(ep.text).toContain("ran successfully");
    expect(ep.source.type).toBe("zapier.zap_run");
    expect(ep.source.id).toBe("12345:67890");
    expect(ep.metadata?.zap_id).toBe("12345");
    expect(ep.metadata?.run_id).toBe("67890");
  });

  it("maps a non-success status to zapier.zap.failed", () => {
    const ep = formatZapToEpisode({ ...baseInput, status: "failure" });
    expect(ep.kind).toBe("zapier.zap.failed");
    expect(ep.text).toContain("failed");
    expect(ep.metadata?.zap_status).toBe("failure");
  });

  it("treats any unknown status as failure for routing while keeping the literal in metadata", () => {
    const ep = formatZapToEpisode({ ...baseInput, status: "halted" });
    expect(ep.kind).toBe("zapier.zap.failed");
    expect(ep.metadata?.zap_status).toBe("halted");
  });

  it("respects options.subject and options.url overrides", () => {
    const ep = formatZapToEpisode(baseInput, {
      subject: "customer:acme",
      url: "https://zapier.com/app/zaps/12345",
    });
    expect(ep.subject).toBe("customer:acme");
    expect(ep.source.url).toBe("https://zapier.com/app/zaps/12345");
  });

  it("uses the input occurred_at when provided", () => {
    const ep = formatZapToEpisode({ ...baseInput, occurred_at: "2026-05-08T12:34:56.000Z" });
    expect(ep.occurred_at).toBe("2026-05-08T12:34:56.000Z");
  });

  it("falls back to now() when occurred_at is omitted", () => {
    const ep = formatZapToEpisode(baseInput);
    expect(new Date(ep.occurred_at).toString()).not.toBe("Invalid Date");
  });

  it("preserves input.data under metadata.data", () => {
    const data = { record_id: "abc-123", customer_email: "user@example.com" };
    const ep = formatZapToEpisode({ ...baseInput, data });
    expect(ep.metadata?.data).toEqual(data);
  });

  it("uses input.text verbatim when provided", () => {
    const ep = formatZapToEpisode({ ...baseInput, text: "explicit override text" });
    expect(ep.text).toBe("explicit override text");
  });

  it("produces deterministic idempotency keys for the same zap+run", () => {
    const a = formatZapToEpisode(baseInput);
    const b = formatZapToEpisode(baseInput);
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });

  it("rejects missing required fields with a useful error message", () => {
    expect(() =>
      formatZapToEpisode({
        ...baseInput,
        zap_id: "",
        run_id: "",
      } as ZapEpisodeInput),
    ).toThrowError(/zap_id, run_id/);
  });

  it("throws ConnectorError, not a plain Error", () => {
    expect(() => formatZapToEpisode({} as ZapEpisodeInput)).toThrow(ConnectorError);
  });
});
