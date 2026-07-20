/**
 * Entitlement sync + the paid path, plus webhook signature verification and the
 * KMS-compatible JWS assembly (tested with a local EC key so no KMS is needed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { jwtVerify, exportJWK, type JSONWebKeySet } from "jose";
import { verifyMagicLinkToken } from "@addressium/magiclink-verify";
import type { List } from "@addressium/core";
import {
  memStores,
  CaptureSender,
  HmacConfirmationSigner,
  SystemClock,
  JoseMagicLinkSigner,
  signup,
  confirmOptIn,
  sendCampaign,
  applyEntitlementSync,
  signWebhook,
  verifyWebhookSignature,
  buildEs256CompactJws,
  type EmailTemplate,
} from "@addressium/domain";
import { generateKeyPair } from "jose";

const ORG = "summit";
const LIST = "ledger";
const ISS = "https://addressium.example/summit";
const AUD = "northwindtimes.example";

const template: EmailTemplate = {
  blocks: [{ kind: "editorial", label: "read", url: "https://northwindtimes.example/a" }],
};

function need<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null) throw new Error(msg);
  return v;
}

async function harness() {
  const stores = memStores();
  const sender = new CaptureSender();
  const clock = new SystemClock();
  const confirmSigner = new HmacConfirmationSigner("secret");
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const magic = new JoseMagicLinkSigner(
    { privateKey, kid: "k1", issuer: ISS, audience: AUD, ttlSeconds: 3600 },
    clock,
  );
  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "l@northwindtimes.example",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "a",
  };
  await stores.lists.put(list);
  return { stores, sender, clock, confirmSigner, magic, jwks };
}

test("entitlement sync flips a subscriber to paid and the token then says paid", async () => {
  const h = await harness();
  const r = await signup(h.stores, h.confirmSigner, h.clock, {
    orgId: ORG,
    email: "jordan@example.com",
    listId: LIST,
  });
  await confirmOptIn(h.stores, h.confirmSigner, h.clock, r.confirmationToken);

  const updated = await applyEntitlementSync(h.stores, h.clock, {
    orgId: ORG,
    subscriberEmail: "jordan@example.com",
    entitlement: "paid",
    source: "stripe",
    version: "evt_1",
  });
  assert.equal(updated.entitlement, "paid");
  assert.ok(updated.entitlementAsof);
  const audit = await h.stores.entitlements.latest(ORG, r.subscriber.sub);
  assert.equal(need(audit, "audit record").value, "paid");

  await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "x",
    template,
  });
  const html = need(h.sender.sent[0], "sent").html;
  const token = need(html.match(/#tok=([^"]+)/), "token")[1]!;
  const claims = await verifyMagicLinkToken(token, { issuer: ISS, audience: AUD, jwks: h.jwks });
  assert.equal(claims.entitlement, "paid");
});

test("webhook signatures verify and reject tampering (constant-time)", () => {
  const body = JSON.stringify({ subscriberEmail: "a@b.com", entitlement: "paid" });
  const sig = signWebhook("whsec", body);
  assert.equal(verifyWebhookSignature("whsec", body, sig), true);
  assert.equal(verifyWebhookSignature("whsec", body + "x", sig), false);
  assert.equal(verifyWebhookSignature("wrong", body, sig), false);
  assert.equal(verifyWebhookSignature("whsec", body, "not-hex-zz"), false);
});

test("KMS-style DER->JOSE JWS assembly produces a valid ES256 token", async () => {
  // Simulate KMS: a signer that returns a DER ECDSA signature. Here we use a
  // local EC P-256 key (node:crypto emits DER by default) — the exact same
  // assembly path the KMS signer uses, so this proves the conversion is correct.
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const now = Math.floor(Date.now() / 1000);
  const token = await buildEs256CompactJws(
    { kid: "kms-1" },
    { sub: "abc", scope: "content:read", amr: ["magic_link"], entitlement: "paid", iss: ISS, aud: AUD, iat: now, exp: now + 3600 },
    async (input) => signDer(input, privateKey),
  );
  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ["ES256"],
    issuer: ISS,
    audience: AUD,
  });
  assert.equal(payload.sub, "abc");
  assert.equal((payload as { entitlement: string }).entitlement, "paid");
});

function signDer(input: Buffer, privateKey: KeyObject): Buffer {
  return createSign("SHA256").update(input).end().sign(privateKey);
}
