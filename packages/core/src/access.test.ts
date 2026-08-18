import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import { describe, expect, it } from "vitest";

import { createAccessGuard } from "./access.js";

const teamDomain = "example.cloudflareaccess.com";
const aud = "access-app-aud";

function request(token?: string) {
  return new Request("https://example.com/admin", {
    headers:
      token === undefined
        ? undefined
        : { "cf-access-jwt-assertion": token },
  });
}

async function keyFixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const getKey = createLocalJWKSet({ keys: [publicJwk] });

  return { privateKey, getKey };
}

async function token(
  privateKey: CryptoKey | Uint8Array,
  overrides: {
    issuer?: string;
    audience?: string;
    expiresAt?: string;
    alg?: string;
  } = {},
) {
  return new SignJWT({ sub: "user@example.com", email: "user@example.com" })
    .setProtectedHeader({ alg: overrides.alg ?? "RS256" })
    .setIssuer(overrides.issuer ?? `https://${teamDomain}`)
    .setAudience(overrides.audience ?? aud)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresAt ?? "1h")
    .sign(privateKey);
}

describe("createAccessGuard", () => {
  it("returns the verified payload for a valid Cloudflare Access JWT", async () => {
    const { privateKey, getKey } = await keyFixture();
    const guard = createAccessGuard({ teamDomain, aud, getKey });
    const jwt = await token(privateKey);

    const result = await guard(request(jwt));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toMatchObject({
        sub: "user@example.com",
        email: "user@example.com",
        iss: `https://${teamDomain}`,
        aud,
      });
    }
  });

  it.each([
    [
      "expired token",
      async (privateKey: CryptoKey) => token(privateKey, { expiresAt: "-1h" }),
    ],
    [
      "audience mismatch",
      async (privateKey: CryptoKey) =>
        token(privateKey, { audience: "other-aud" }),
    ],
    [
      "issuer mismatch",
      async (privateKey: CryptoKey) =>
        token(privateKey, { issuer: "https://other.cloudflareaccess.com" }),
    ],
    [
      "token signed by another key",
      async () => {
        const { privateKey } = await keyFixture();
        return token(privateKey);
      },
    ],
    [
      "HS256 token",
      async () => token(new TextEncoder().encode("secret"), { alg: "HS256" }),
    ],
  ])("rejects %s", async (_name, createToken) => {
    const { privateKey, getKey } = await keyFixture();
    const guard = createAccessGuard({ teamDomain, aud, getKey });
    const jwt = await createToken(privateKey);

    const result = await guard(request(jwt));

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Invalid Access token",
    });
  });

  it("rejects a missing Access JWT header", async () => {
    const getKey = (() => {
      throw new Error("getKey should not be called");
    }) as JWTVerifyGetKey;
    const guard = createAccessGuard({ teamDomain, aud, getKey });

    const result = await guard(request());

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Missing Access token",
    });
  });

  it("rejects an unparsable Access JWT header", async () => {
    const { getKey } = await keyFixture();
    const guard = createAccessGuard({ teamDomain, aud, getKey });

    const result = await guard(request("not a jwt"));

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Invalid Access token",
    });
  });

  it.each([
    ["teamDomain", { teamDomain: "", aud }],
    ["aud", { teamDomain, aud: "" }],
  ])("throws when %s is empty", (_name, options) => {
    expect(() => createAccessGuard(options)).toThrow();
  });
});
