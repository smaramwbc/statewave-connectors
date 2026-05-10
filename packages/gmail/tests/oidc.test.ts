// End-to-end OIDC verifier tests. We generate a real RSA keypair
// up-front, expose the public key as a JWK set the verifier fetches
// via injected fetch, and sign tokens with the matching private key
// using the same `jose` the verifier uses. That gives genuine
// cryptographic round-trip coverage without requiring a real network
// fetch or Google's actual rotating keys.

import { describe, it, expect, beforeAll } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import {
  createGoogleOidcVerifier,
  GOOGLE_ISSUER,
} from "../src/oidc.js";

const AUDIENCE = "https://my-runner.example.com/gmail/founder/events";
const KID = "test-key-2026";

interface Keys {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function generateKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = KID;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { privateKey, publicJwk };
}

interface MintTokenOptions {
  audience?: string;
  issuer?: string;
  email?: string;
  expSecondsFromNow?: number;
  iatSecondsFromNow?: number;
  algOverride?: string;
}

async function mintToken(
  keys: Keys,
  options: MintTokenOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({
    ...(options.email ? { email: options.email } : {}),
  })
    .setProtectedHeader({ alg: options.algOverride ?? "RS256", kid: KID })
    .setIssuer(options.issuer ?? GOOGLE_ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(now + (options.iatSecondsFromNow ?? 0))
    .setExpirationTime(now + (options.expSecondsFromNow ?? 3600));
  return builder.sign(keys.privateKey);
}

function makeRequest(token: string, headerName = "authorization"): Request {
  return new Request("http://localhost/gmail/founder/events", {
    method: "POST",
    headers: { [headerName]: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
}

describe("createGoogleOidcVerifier", () => {
  let keys: Keys;

  beforeAll(async () => {
    keys = await generateKeys();
  });

  it("accepts a valid token signed by a key in the JWKs", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      jwksUri: "http://test/jwks",
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    const token = await mintToken(keys);
    const result = await verifier.verifyRequest(makeRequest(token));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.aud).toBe(AUDIENCE);
      expect(result.payload.iss).toBe(GOOGLE_ISSUER);
    }
  });

  it("rejects when the Authorization header is missing", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      jwksUri: "http://test/jwks",
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    const req = new Request("http://test/", { method: "POST" });
    const result = await verifier.verifyRequest(req);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("missing_authorization_header");
  });

  it("rejects a malformed Authorization header", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      jwksUri: "http://test/jwks",
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    const req = new Request("http://test/", {
      method: "POST",
      headers: { authorization: "Basic xyz" },
    });
    const result = await verifier.verifyRequest(req);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("malformed_authorization_header");
  });

  it("rejects a token with the wrong audience", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      jwksUri: "http://test/jwks",
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    const token = await mintToken(keys, { audience: "https://wrong.example.com" });
    const result = await verifier.verifyRequest(makeRequest(token));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.toLowerCase()).toMatch(/aud|audience|claim/);
    }
  });

  it("rejects a token with the wrong issuer", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      jwksUri: "http://test/jwks",
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    const token = await mintToken(keys, { issuer: "https://attacker.example.com" });
    const result = await verifier.verifyRequest(makeRequest(token));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.toLowerCase()).toMatch(/iss|issuer|claim/);
    }
  });

  it("rejects an expired token (no leeway)", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      jwksUri: "http://test/jwks",
      leewaySec: 0,
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    const token = await mintToken(keys, { expSecondsFromNow: -120, iatSecondsFromNow: -180 });
    const result = await verifier.verifyRequest(makeRequest(token));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.toLowerCase()).toMatch(/expired|exp/);
    }
  });

  it("accepts a token expired within the leeway window", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      jwksUri: "http://test/jwks",
      leewaySec: 300,
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    // Expired 60s ago — inside the 300s leeway window.
    const token = await mintToken(keys, { expSecondsFromNow: -60, iatSecondsFromNow: -120 });
    const result = await verifier.verifyRequest(makeRequest(token));
    expect(result.valid).toBe(true);
  });

  it("rejects a token whose signature is from a different keypair", async () => {
    const otherKeys = await generateKeys();
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      jwksUri: "http://test/jwks",
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    // Mint a token signed by `otherKeys` but advertise `keys`'s kid in
    // the JWKs — the signature won't match the public key and jose
    // will reject. We mint with a clean kid (no override) so the
    // token's kid doesn't match either.
    const token = await mintToken(otherKeys);
    const result = await verifier.verifyRequest(makeRequest(token));
    expect(result.valid).toBe(false);
  });

  it("enforces email allowlist when configured (allow)", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      expectedEmails: ["allowed@my-project.iam.gserviceaccount.com"],
      jwksUri: "http://test/jwks",
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    const token = await mintToken(keys, {
      email: "allowed@my-project.iam.gserviceaccount.com",
    });
    const result = await verifier.verifyRequest(makeRequest(token));
    expect(result.valid).toBe(true);
  });

  it("enforces email allowlist when configured (deny)", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      expectedEmails: ["allowed@my-project.iam.gserviceaccount.com"],
      jwksUri: "http://test/jwks",
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    const token = await mintToken(keys, {
      email: "stranger@other-project.iam.gserviceaccount.com",
    });
    const result = await verifier.verifyRequest(makeRequest(token));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/email_not_allowed/);
    }
  });

  it("rejects when allowlist is set but the token has no email claim", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      expectedEmails: ["someone@example.com"],
      jwksUri: "http://test/jwks",
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    const token = await mintToken(keys); // no email claim
    const result = await verifier.verifyRequest(makeRequest(token));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("missing_email_claim");
  });

  it("email allowlist matches case-insensitively", async () => {
    const verifier = createGoogleOidcVerifier({
      audience: AUDIENCE,
      expectedEmails: ["MixedCase@Example.com"],
      jwksUri: "http://test/jwks",
      jwksCache: { jwks: { keys: [keys.publicJwk] }, uat: Date.now() },
    });
    const token = await mintToken(keys, { email: "mixedcase@example.com" });
    const result = await verifier.verifyRequest(makeRequest(token));
    expect(result.valid).toBe(true);
  });

  it("requires audience at construction time", () => {
    expect(() =>
      // @ts-expect-error testing runtime guard
      createGoogleOidcVerifier({ audience: "" }),
    ).toThrow(/audience/i);
  });
});
