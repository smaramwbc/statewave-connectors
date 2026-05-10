// Auth check on the `/metrics` endpoint.
//
// Health endpoints (`/healthz`, `/readyz`) stay unauthenticated —
// orchestrators may not have credentials, and exposing them is the
// whole point. `/metrics` is different: cardinality, labels, and
// counter values can leak ingest volumes, source names, and error
// rates. Operators on a public-internet runner want this gated.
//
// Three modes — config-validator already enforces shapes, so this
// only does the runtime compare:
//   - none: no check (fine on trusted networks)
//   - basic: `Authorization: Basic <base64(user:pass)>`
//   - bearer: `Authorization: Bearer <token>`
//
// Compares are constant-time so timing leaks don't reveal the secret.

import type { RunnerMetricsAuth } from "@statewavedev/connectors-config";

export interface MetricsAuthCheck {
  /** Returns true if the request is allowed to scrape `/metrics`. */
  authorize(req: Request): boolean;
}

export function makeMetricsAuthCheck(auth: RunnerMetricsAuth | undefined): MetricsAuthCheck {
  if (!auth || auth.kind === "none") {
    return { authorize: () => true };
  }
  if (auth.kind === "basic") {
    const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
    return {
      authorize(req: Request): boolean {
        const presented = req.headers.get("authorization");
        if (!presented) return false;
        return constantTimeEqual(presented, expected);
      },
    };
  }
  if (auth.kind === "bearer") {
    const expected = `Bearer ${auth.token}`;
    return {
      authorize(req: Request): boolean {
        const presented = req.headers.get("authorization");
        if (!presented) return false;
        return constantTimeEqual(presented, expected);
      },
    };
  }
  // Exhaustive — config validator rejects anything else, but TS can't
  // narrow through the union without a helper.
  const exhaustive: never = auth;
  throw new Error(`unknown metrics auth kind: ${JSON.stringify(exhaustive)}`);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
