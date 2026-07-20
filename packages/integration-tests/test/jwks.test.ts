/**
 * KMS-style SPKI/DER → JWK conversion: a token signed by the private key must
 * verify against the derived JWK (proves the tokens-service JWKS output works).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { jwtVerify, type JSONWebKeySet } from "jose";
import { spkiDerToJwk } from "@addressium/adapters-aws";
import { buildEs256CompactJws } from "@addressium/domain";

function signDer(input: Buffer, privateKey: KeyObject): Buffer {
  return createSign("SHA256").update(input).end().sign(privateKey);
}

test("spkiDerToJwk yields a JWK that verifies real ES256 tokens", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const jwk = spkiDerToJwk(spkiDer, "kms-1");
  assert.equal(jwk.kty, "EC");
  assert.equal(jwk.kid, "kms-1");
  assert.equal(jwk.alg, "ES256");

  const now = Math.floor(Date.now() / 1000);
  const token = await buildEs256CompactJws(
    { kid: "kms-1" },
    { sub: "abc", iss: "iss", aud: "aud", iat: now, exp: now + 3600 },
    async (input) => signDer(input, privateKey),
  );

  const jwks: JSONWebKeySet = { keys: [jwk as unknown as JSONWebKeySet["keys"][number]] };
  const { createLocalJWKSet } = await import("jose");
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
    algorithms: ["ES256"],
    issuer: "iss",
    audience: "aud",
  });
  assert.equal(payload.sub, "abc");
});
