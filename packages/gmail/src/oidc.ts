// Built-in OIDC verifier for Cloud Pub/Sub push delivery.
//
// Pub/Sub can sign every push request with a Google-issued OIDC token
// in `Authorization: Bearer <id_token>`. The token is an RS256 JWT
// with claims:
//
//   iss = "https://accounts.google.com"
//   aud = the operator-configured audience (a string, usually the
//         endpoint URL or any operator-chosen identifier)
//   email = the service account email Pub/Sub uses to sign
//   exp / iat as usual
//
// The receiver fetches Google's public JWKs from
// `https://www.googleapis.com/oauth2/v3/certs`, caches them in memory
// for an hour (Google rotates rarely; the cache absorbs the rotation
// gap on the next miss), and verifies each delivery's signature +
// claims before processing the body.
//
// We delegate the actual JWT cryptography to `jose` — it's small,
// audited, ESM-native, and handles the algorithm-confusion edge cases
// that hand-rolled JWT verifiers historically get wrong.

import {
  createRemoteJWKSet,
  jwksCache,
  jwtVerify,
  type ExportedJWKSCache,
  type JWTPayload,
} from "jose";

export const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUER = "https://accounts.google.com";

export interface GmailOidcConfig {
  /**
   * Expected `aud` claim. Operators set this on the Pub/Sub push
   * subscription's "Authentication" page (Google Cloud Console →
   * Pub/Sub → Subscriptions → … → Authentication audience). Required.
   */
  audience: string;
  /**
   * Optional allowlist of `email` claims. When set, the JWT's `email`
   * must match one of these values. Useful when the operator has
   * multiple Pub/Sub subscriptions sharing one endpoint and wants to
   * restrict which service account is allowed to deliver.
   */
  expectedEmails?: ReadonlyArray<string>;
  /** Override the JWKs URI. Default Google's well-known endpoint. */
  jwksUri?: string;
  /** Override the expected `iss` claim. Default `https://accounts.google.com`. */
  issuer?: string;
  /** Clock-skew leeway in seconds. Default 60. */
  leewaySec?: number;
  /**
   * Pre-warm the JWKs cache. When set, the verifier seeds jose's
   * remote-JWKs cache with these keys and skips the network fetch as
   * long as the cache stays fresh (jose's cooldownDuration controls
   * the re-fetch window). Used in tests to avoid hitting the live
   * Google endpoint; production deployments leave this unset.
   */
  jwksCache?: ExportedJWKSCache;
}

export type OidcVerifyResult =
  | { valid: true; payload: JWTPayload }
  | { valid: false; reason: string };

export interface OidcVerifier {
  /** Pull the bearer token off `Authorization`, verify it, and return
   * the result. Pure async — never throws on bad tokens; returns a
   * `valid: false` result with an operator-friendly reason instead. */
  verifyRequest(req: Request): Promise<OidcVerifyResult>;
}

/**
 * Build a verifier bound to a specific OIDC config. The returned
 * verifier caches the JWKs internally — sharing one verifier across
 * receivers (or even across processes via the runner's startup wiring)
 * keeps the JWKs fetch budget low.
 */
export function createGoogleOidcVerifier(config: GmailOidcConfig): OidcVerifier {
  const jwksUri = config.jwksUri ?? GOOGLE_JWKS_URI;
  const issuer = config.issuer ?? GOOGLE_ISSUER;
  const leeway = config.leewaySec ?? 60;
  const expectedEmails = config.expectedEmails
    ? new Set(config.expectedEmails.map((e) => e.toLowerCase()))
    : undefined;
  const audience = config.audience;
  if (!audience) {
    throw new Error("createGoogleOidcVerifier: audience is required");
  }
  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    ...(config.jwksCache ? { [jwksCache]: config.jwksCache } : {}),
  });

  return {
    async verifyRequest(req: Request): Promise<OidcVerifyResult> {
      const auth = req.headers.get("authorization");
      if (!auth) return { valid: false, reason: "missing_authorization_header" };
      const match = /^Bearer\s+(\S+)$/i.exec(auth);
      if (!match) return { valid: false, reason: "malformed_authorization_header" };
      const token = match[1];
      if (!token) return { valid: false, reason: "empty_bearer_token" };

      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(token, jwks, {
          issuer,
          audience,
          algorithms: ["RS256"],
          clockTolerance: leeway,
        });
        payload = verified.payload;
      } catch (err) {
        // jose throws typed errors with `code` like
        // ERR_JWT_EXPIRED / ERR_JWT_CLAIM_VALIDATION_FAILED. We
        // surface the code and message so operators can debug why
        // their Pub/Sub deliveries are 401-ing without us leaking
        // the token contents.
        const code = (err as { code?: string }).code ?? "verify_failed";
        const message = err instanceof Error ? err.message : String(err);
        return { valid: false, reason: `${code}: ${message}` };
      }

      if (expectedEmails) {
        const email = typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
        if (!email) {
          return { valid: false, reason: "missing_email_claim" };
        }
        if (!expectedEmails.has(email)) {
          return { valid: false, reason: `email_not_allowed: ${email}` };
        }
      }

      return { valid: true, payload };
    },
  };
}
