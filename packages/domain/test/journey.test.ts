/**
 * Vertical slice, end-to-end and AWS-free:
 *   signup → double opt-in → send → open/click → click map,
 * plus the security controls: magic-link ES256 verification (RFC 8725),
 * algorithm-confusion rejection, token redaction, suppression, and the SSRF
 * guard. Runs on the built-in node:test runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from "jose";
import { verifyMagicLinkToken, tryVerifyMagicLinkToken } from "@addressium/magiclink-verify";
import { assertPublicHttpsUrl, SsrfBlockedError } from "@addressium/svc-feeds";
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
  recordOpen,
  recordClick,
  buildClickMap,
  redactToken,
  type EmailTemplate,
} from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";
const ISS = "https://addressium.example/summit";
const AUD = "summitdaily.com";
const KID = "test-key-1";
const ARTICLE = "https://summitdaily.com/markets/the-chart";

const template: EmailTemplate = {
  blocks: [
    { kind: "text", html: "Good morning, {{first_name}}." },
    { kind: "editorial", label: "the chart everyone's sharing", url: ARTICLE },
    { kind: "ad", slot: "ad_top", html: '<a href="https://li.example/x"><img src="https://li.example/c.png"></a>' },
  ],
};

function need<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null) throw new Error(msg);
  return v;
}

async function harness() {
  const stores = memStores();
  const sender = new CaptureSender();
  const clock = new SystemClock();
  const confirmSigner = new HmacConfirmationSigner("unit-test-secret");
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const magic = new JoseMagicLinkSigner(
    { privateKey, kid: KID, issuer: ISS, audience: AUD, ttlSeconds: 3600 },
    clock,
  );
  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "The Morning Ledger",
    optInPolicy: "double",
    fromAddress: "ledger@summitdaily.com",
    access: "free",
    visibility: "open",
    complianceFooter: "Summit Daily · 40 W Main St, Frisco CO",
    physicalAddress: "40 W Main St, Frisco CO",
  };
  await stores.lists.put(list);
  return { stores, sender, clock, confirmSigner, magic, jwks };
}

function tokenFrom(html: string): string {
  const m = html.match(/#tok=([^"]+)/);
  return need(m, "editorial link should carry a token in its fragment")[1]!;
}

test("signup → double opt-in → send, and the magic-link token verifies", async () => {
  const h = await harness();

  const res = await signup(h.stores, h.confirmSigner, h.clock, {
    orgId: ORG,
    email: "Jordan@Example.com",
    listId: LIST,
    attributes: { first_name: "Jordan" },
    sourceUrl: "https://summitdaily.com/signup",
  });
  assert.equal(res.subscription.status, "pending");
  assert.equal(res.subscriber.email, "jordan@example.com");

  const confirmed = await confirmOptIn(h.stores, h.confirmSigner, h.clock, res.confirmationToken);
  assert.equal(confirmed.status, "confirmed");

  const out = await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "The one chart",
    template,
  });
  assert.equal(out.sent, 1);
  const msg = need(h.sender.sent[0], "one message sent");
  assert.equal(msg.to, "jordan@example.com");
  assert.match(msg.html, /Good morning, Jordan\./); // merge tag applied
  assert.match(msg.html, /li\.example\/c\.png/); // ad slot verbatim
  assert.ok(msg.listUnsubscribe.startsWith("<https://unsub."), "RFC 8058 header");

  const claims = await verifyMagicLinkToken(tokenFrom(msg.html), {
    issuer: ISS,
    audience: AUD,
    jwks: h.jwks,
  });
  assert.equal(claims.sub, res.subscriber.sub);
  assert.equal(claims.scope, "content:read");
  assert.deepEqual(claims.amr, ["magic_link"]);
  assert.equal(claims.entitlement, "free");
});

test("verifier rejects wrong audience, tampering, and algorithm confusion", async () => {
  const h = await harness();
  const token = await h.magic.mint({ orgId: ORG, sub: "abc", entitlement: "paid" });

  // wrong audience
  await assert.rejects(() =>
    verifyMagicLinkToken(token, { issuer: ISS, audience: "evil.example", jwks: h.jwks }),
  );

  // tampered signature → graceful null
  assert.equal(await tryVerifyMagicLinkToken(token.slice(0, -4) + "AAAA", { issuer: ISS, audience: AUD, jwks: h.jwks }), null);

  // ALGORITHM CONFUSION: an HS256 token must never be accepted (RFC 8725).
  const forged = await new SignJWT({ scope: "content:read", amr: ["magic_link"], entitlement: "paid" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("abc")
    .setIssuer(ISS)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("public-key-bytes-as-secret"));
  assert.equal(await tryVerifyMagicLinkToken(forged, { issuer: ISS, audience: AUD, jwks: h.jwks }), null);
});

test("suppression is enforced before send", async () => {
  const h = await harness();
  for (const [email, name] of [["jordan@example.com", "Jordan"], ["mei@okafor.studio", "Mei"]] as const) {
    const r = await signup(h.stores, h.confirmSigner, h.clock, {
      orgId: ORG,
      email,
      listId: LIST,
      attributes: { first_name: name },
    });
    await confirmOptIn(h.stores, h.confirmSigner, h.clock, r.confirmationToken);
  }
  await h.stores.suppression.add({
    orgId: ORG,
    email: "mei@okafor.studio",
    source: "complaint",
    scope: "org",
    addedAt: h.clock.now().toISOString(),
  });

  const out = await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c2",
    listId: LIST,
    subject: "x",
    template,
  });
  assert.equal(out.sent, 1);
  assert.equal(out.suppressed, 1);
});

test("click map aggregates by link-id and the token is redacted at rest", async () => {
  const h = await harness();
  const r = await signup(h.stores, h.confirmSigner, h.clock, {
    orgId: ORG,
    email: "jordan@example.com",
    listId: LIST,
    attributes: { first_name: "Jordan" },
  });
  await confirmOptIn(h.stores, h.confirmSigner, h.clock, r.confirmationToken);
  await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c3",
    listId: LIST,
    subject: "x",
    template,
  });

  const token = tokenFrom(need(h.sender.sent[0], "sent").html);
  const clickedUrl = `${ARTICLE}#tok=${token}`;
  assert.equal(redactToken(clickedUrl), ARTICLE);

  await recordOpen(h.stores, h.clock, ORG, "c3", r.subscriber.sub);
  const linkId = await recordClick(h.stores, h.clock, {
    orgId: ORG,
    campaignId: "c3",
    subscriberId: r.subscriber.sub,
    clickedUrl,
  });
  assert.equal(linkId, "l0");

  const map = await buildClickMap(h.stores, ORG, "c3");
  assert.equal(map.sent, 1);
  const row = need(map.rows.find((x) => x.linkId === "l0"), "l0 row");
  assert.equal(row.clicks, 1);
  assert.equal(row.unique, 1);

  // No persisted event may contain a token.
  const events = await h.stores.events.all(ORG, "c3");
  for (const e of events) assert.ok(!JSON.stringify(e).includes("tok="), "no token at rest");
});

test("SSRF guard blocks internal targets and allows public ones", async () => {
  await assert.rejects(() => assertPublicHttpsUrl("http://summitdaily.com/feed"), SsrfBlockedError); // not https
  await assert.rejects(() => assertPublicHttpsUrl("https://169.254.169.254/latest/meta-data/"), SsrfBlockedError);
  await assert.rejects(() => assertPublicHttpsUrl("https://10.0.0.5/feed"), SsrfBlockedError);
  await assert.rejects(() => assertPublicHttpsUrl("https://127.0.0.1/feed"), SsrfBlockedError);
  const ok = await assertPublicHttpsUrl("https://1.1.1.1/feed"); // literal public IP, no DNS
  assert.equal(ok.pinnedAddress, "1.1.1.1");
});
