/**
 * Magic links are an org-level feature (#22, §4.9). Both modes must work fully:
 * ON mints a token carrying addressium's own `sub`, the linked pool's `sub` and
 * the entitlement; OFF sends the same mail with untokenized editorial links.
 *
 * The subtle case is ON-but-unlinked: a subscriber with no `externalId` gets no
 * token rather than an unresolvable one, and the send still succeeds. These
 * assert that path explicitly, because it is the one that would otherwise
 * silently degrade for every subscriber predating the toggle.
 */
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, type JSONWebKeySet } from "jose";
import test from "node:test";
import { verifyMagicLinkToken } from "@addressium/magiclink-verify";
import { schemas, type List } from "@addressium/core";
import {
  CaptureSender,
  HmacConfirmationSigner,
  JoseMagicLinkSigner,
  SystemClock,
  buildLinkMap,
  confirmOptIn,
  memStores,
  provisionSubscriberAccount,
  sendCampaign,
  signup,
  type EmailTemplate,
  type Stores,
} from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";
const ISS = "https://addressium.example/summit";
const AUD = "northwindtimes.example";
const KID = "test-key-1";
const ARTICLE = "https://northwindtimes.example/markets/the-chart";

const template: EmailTemplate = {
  blocks: [
    { kind: "text", html: "<p>Hello {{first_name}}</p>" },
    { kind: "editorial", url: ARTICLE, label: "The chart" },
    { kind: "ad", slot: "mid", html: `<a href="https://ads.example/x">sponsor</a>` },
  ],
};

async function harness() {
  const stores = memStores();
  const sender = new CaptureSender();
  const clock = new SystemClock();
  const confirmSigner = new HmacConfirmationSigner("test-secret");
  const { privateKey, publicKey } = await generateKeyPair("ES256");
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
    fromAddress: "ledger@northwindtimes.example",
    access: "free",
    visibility: "open",
    complianceFooter: "Northwind Times · 123 Main Street, Anytown, USA",
    physicalAddress: "123 Main Street, Anytown, USA",
  };
  await stores.lists.put(list);
  return { stores, sender, clock, confirmSigner, magic, jwks };
}

/** Signup + confirm, optionally linking a pool account the way the API does. */
async function subscriber(h: Awaited<ReturnType<typeof harness>>, link: boolean) {
  const r = await signup(h.stores, h.confirmSigner, h.clock, {
    orgId: ORG,
    email: "jordan@example.com",
    listId: LIST,
    attributes: { first_name: "Jordan" },
  });
  await confirmOptIn(h.stores, h.confirmSigner, h.clock, r.confirmationToken);
  if (link) {
    await provisionSubscriberAccount(
      h.stores,
      { ensureAccount: async () => ({ externalId: "pool-sub-123" }) },
      ORG,
      "us-east-1_testpool",
      r.subscriber.sub,
    );
  }
  return r;
}

const send = (h: Awaited<ReturnType<typeof harness>>, magic: Parameters<typeof sendCampaign>[2]) =>
  sendCampaign(h.stores, h.sender, magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "x",
    template,
  });

test("magic links OFF: the send succeeds and carries no token", async () => {
  const h = await harness();
  await subscriber(h, true); // linked, to prove the SIGNER is what gates minting

  const out = await send(h, undefined);
  assert.equal(out.sent, 1);

  const html = h.sender.sent[0]?.html ?? "";
  assert.ok(!html.includes("#tok="), "no token may appear with the feature off");
  assert.ok(html.includes(ARTICLE), "the editorial link is still there, just untokenized");
});

test("magic links OFF: click tracking is unaffected — link-ids and the map are identical", async () => {
  const h = await harness();
  await subscriber(h, true);
  await send(h, undefined);

  const html = h.sender.sent[0]?.html ?? "";
  assert.ok(/data-linkid="l0"/.test(html), "the stable link-id survives without a token");

  // The archived link map is what a click resolves against, so it must not
  // depend on the feature being on.
  const map = buildLinkMap(template);
  assert.equal(map["l0"]?.urlTemplate, ARTICLE);
  assert.equal(map["l0"]?.class, "editorial");
});

test("magic links ON: the token carries both ids and the entitlement", async () => {
  const h = await harness();
  await subscriber(h, true);

  const out = await send(h, h.magic);
  assert.equal(out.sent, 1);
  assert.ok(!out.untokenized, "a linked subscriber must get a token");

  const html = h.sender.sent[0]?.html ?? "";
  const token = html.match(/#tok=([^"]+)/)?.[1];
  assert.ok(token, "editorial link should carry a token in its fragment");

  const claims = await verifyMagicLinkToken(token, { issuer: ISS, audience: AUD, jwks: h.jwks });
  // addressium's own durable id...
  assert.ok(claims.sub.length > 0);
  assert.notEqual(claims.sub, "pool-sub-123");
  // ...and the linked pool's sub, so a paywall resolves the reader with no call back.
  assert.equal((claims as Record<string, unknown>)["external_sub"], "pool-sub-123");
  assert.equal(claims.entitlement, "free");
  assert.equal(claims.scope, "content:read");
});

test("magic links ON but subscriber unlinked: no token, and the send still succeeds", async () => {
  const h = await harness();
  await subscriber(h, false); // no externalId

  const out = await send(h, h.magic);
  assert.equal(out.sent, 1, "a missing pool account must never fail the send");
  assert.equal(out.untokenized, 1, "and it must be visible, not silent");

  const html = h.sender.sent[0]?.html ?? "";
  assert.ok(
    !html.includes("#tok="),
    "minting without the pool sub would produce a token no paywall can resolve",
  );
  assert.ok(/data-linkid="l0"/.test(html), "click tracking still works");
});

test("createOrgSchema refuses magic links without a linked pool", () => {
  const base = {
    name: "Northwind Times",
    primaryDomain: "northwindtimes.example",
    siteDomain: "northwindtimes.example",
  };
  const bad = schemas.createOrgSchema.safeParse({ ...base, magicLinks: true });
  assert.equal(bad.success, false, "the token needs a pool sub, so the pair is mandatory");

  const good = schemas.createOrgSchema.safeParse({
    ...base,
    magicLinks: true,
    subscriberPool: { poolId: "us-east-1_abc" },
  });
  assert.equal(good.success, true);
});

test("createOrgSchema accepts a pure sender with no pool at all", () => {
  const parsed = schemas.createOrgSchema.safeParse({
    name: "Northwind Times",
    primaryDomain: "northwindtimes.example",
    siteDomain: "northwindtimes.example",
  });
  assert.equal(parsed.success, true, "magic links off means no pool is required");
  assert.ok(!parsed.data?.magicLinks);
});

test("provisioning an org with magic links off touches neither Cognito nor KMS", async () => {
  const { provisionOrganization } = await import("@addressium/domain");
  const stores: Stores = memStores();
  let poolCalls = 0;
  let keyCalls = 0;

  const result = await provisionOrganization(
    stores,
    {
      linkSubscriberPool: async () => {
        poolCalls++;
        return { poolId: "pool-x" };
      },
      createSigningKey: async () => {
        keyCalls++;
        return { kmsKeyArn: "arn:aws:kms:...:key/abc", kid: "abc" };
      },
      ensureSesDomainIdentity: async () => ({
        configSet: "addressium-northwind",
        dkimTokens: ["t1"],
        verificationStatus: "pending",
      }),
    },
    {
      name: "Northwind Times",
      primaryDomain: "northwindtimes.example",
      siteDomain: "northwindtimes.example",
      region: "us-east-1",
      defaultTimezone: "UTC",
      magicLinks: false,
      dedicatedIp: false,
      dmarcPolicy: "none",
    suppressionScope: "hybrid",
      environment: "prod",
    },
  );

  assert.equal(poolCalls, 0, "no user pool is linked for a pure sender");
  assert.equal(keyCalls, 0, "and no KMS key is created — it would cost money for nothing");
  assert.equal(result.org.magicLink, undefined);
  assert.equal(result.org.subscriberPoolId, undefined);
  // SES is unconditional: it is how mail goes out in both modes.
  assert.equal(result.org.sesConfigSet, "addressium-northwind");
});
