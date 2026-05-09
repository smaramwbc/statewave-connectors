import { describe, it, expect } from "vitest";
import { computeSignature, verifySlackSignature } from "../src/index.js";

const secret = "test-signing-secret";
const body = '{"type":"url_verification","challenge":"abc123"}';
// Pin a fixed wall clock for the tests so they're not time-of-day-flaky.
const now = () => 1_700_000_300;
const ts = 1_700_000_000; // 5 minutes earlier

function sign(): string {
  return "v0=" + computeSignature(secret, ts, body);
}

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request", () => {
    const r = verifySlackSignature({
      signingSecret: secret,
      rawBody: body,
      signatureHeader: sign(),
      timestampHeader: String(ts),
      now,
    });
    expect(r).toEqual({ ok: true });
  });

  it("rejects when headers are missing", () => {
    const r = verifySlackSignature({
      signingSecret: secret,
      rawBody: body,
      signatureHeader: null,
      timestampHeader: String(ts),
      now,
    });
    expect(r).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects timestamps older than the replay window", () => {
    const r = verifySlackSignature({
      signingSecret: secret,
      rawBody: body,
      signatureHeader: sign(),
      // 6 minutes old — outside the default 5-minute window.
      timestampHeader: String(now() - 360),
      now,
    });
    expect(r).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a wrong signature", () => {
    const r = verifySlackSignature({
      signingSecret: secret,
      rawBody: body,
      // Same length as a real signature so we exercise timingSafeEqual,
      // not the length-shortcut path.
      signatureHeader: "v0=" + "0".repeat(64),
      timestampHeader: String(ts),
      now,
    });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature signed with a different secret", () => {
    const wrong = "v0=" + computeSignature("other-secret", ts, body);
    const r = verifySlackSignature({
      signingSecret: secret,
      rawBody: body,
      signatureHeader: wrong,
      timestampHeader: String(ts),
      now,
    });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects when the body bytes have been tampered with", () => {
    const r = verifySlackSignature({
      signingSecret: secret,
      rawBody: body + " ", // trailing space invalidates the hash
      signatureHeader: sign(),
      timestampHeader: String(ts),
      now,
    });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an unparseable timestamp", () => {
    const r = verifySlackSignature({
      signingSecret: secret,
      rawBody: body,
      signatureHeader: sign(),
      timestampHeader: "not-a-number",
      now,
    });
    expect(r).toEqual({ ok: false, reason: "missing_headers" });
  });
});
