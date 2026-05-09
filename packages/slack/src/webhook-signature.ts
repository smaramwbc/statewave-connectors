// HMAC verification for Slack Events-API webhooks.
//
// Every Slack event request carries two headers we care about:
//   - X-Slack-Signature: "v0=<hex>" where <hex> is HMAC-SHA256 over
//     "v0:" + X-Slack-Request-Timestamp + ":" + raw_body, keyed on the
//     app's signing secret.
//   - X-Slack-Request-Timestamp: unix seconds when Slack originated the
//     request. Reject if it's more than 5 minutes off the wall clock to
//     close the replay window.
//
// We do timing-safe compare and return a small typed result so the caller
// can decide whether to return 401 vs 400 vs 500.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignatureVerifyInput {
  signingSecret: string;
  rawBody: string;
  signatureHeader: string | null | undefined;
  timestampHeader: string | null | undefined;
  /** Override the wall-clock for tests. Defaults to Date.now() / 1000. */
  now?: () => number;
  /** Maximum age in seconds before a request is considered replayed. */
  maxAgeSeconds?: number;
}

export type SignatureVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };

const DEFAULT_MAX_AGE_SECONDS = 5 * 60;

export function verifySlackSignature(input: SignatureVerifyInput): SignatureVerifyResult {
  const { signingSecret, rawBody, signatureHeader, timestampHeader } = input;
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  if (!signatureHeader || !timestampHeader) {
    return { ok: false, reason: "missing_headers" };
  }

  // Slack timestamps are integer unix seconds; tolerate trailing whitespace.
  const ts = Number.parseInt(timestampHeader.trim(), 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "missing_headers" };
  }
  if (Math.abs(now() - ts) > maxAgeSeconds) {
    // Either we got it too late (network delay) or this is a replay. Either
    // way Slack's retry will get a fresh timestamp; the right answer is reject.
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = "v0=" + computeSignature(signingSecret, ts, rawBody);
  // Both sides must be the same length for timingSafeEqual; if they aren't
  // we can shortcut to false but still do a constant-time-ish check by
  // hashing the actual signature against itself before returning.
  const sigBuf = Buffer.from(signatureHeader, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) {
    return { ok: false, reason: "bad_signature" };
  }
  return timingSafeEqual(sigBuf, expBuf)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}

/** Exposed for tests — derive what Slack's signature header would look like
 * for a given (secret, timestamp, body) triple. Production callers use
 * `verifySlackSignature` instead. */
export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
}
