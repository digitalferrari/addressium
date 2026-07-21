/**
 * Dev-org send allowlist (§4.11, #77 fast-follow): a `dev` org may only send to
 * addresses on its explicit allowlist — exact emails or `@domain` suffixes —
 * and with no allowlist it sends to no one (fail-closed). Prod orgs are never
 * gated. This keeps a test publication from ever reaching a real subscriber.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "jose";
import type { List, Organization } from "@addressium/core";
import {
  memStores,
  CaptureSender,
  HmacConfirmationSigner,
  SystemClock,
  JoseMagicLinkSigner,
  signup,
  confirmOptIn,
  sendCampaign,
  sendToSubscriber,
  recipientAllowedForDev,
  type EmailTemplate,
} from "@addressium/domain";

const ORG = "devsummit";
const LIST = "ledger";
const template: EmailTemplate = {
  blocks: [{ kind: "editorial", label: "read", url: "https://devsummitdaily.example/a" }],
};

function orgRecord(over: Partial<Organization>): Organization {
  return {
    orgId: ORG,
    name: "Dev Summit Daily",
    domains: ["devsummitdaily.example"],
    subscriberPoolId: "pool",
    magicLink: { kmsKeyArn: "arn", kid: "k", issuer: "iss", audience: "aud" },
    sesConfigSet: "cs",
    ipMode: "shared",
    suppressionScope: "hybrid",
    defaultTimezone: "UTC",
    setupComplete: true,
    ...over,
  };
}

async function harness(org?: Organization) {
  const stores = memStores();
  const sender = new CaptureSender();
  const clock = new SystemClock();
  const confirmSigner = new HmacConfirmationSigner("secret");
  const { privateKey } = await generateKeyPair("ES256");
  const magic = new JoseMagicLinkSigner(
    { privateKey, kid: "k1", issuer: "iss", audience: "aud", ttlSeconds: 3600 },
    clock,
  );
  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "l@devsummitdaily.example",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "a",
  };
  await stores.lists.put(list);
  if (org) await stores.organizations.put(org);
  return { stores, sender, clock, confirmSigner, magic };
}

type H = Awaited<ReturnType<typeof harness>>;
async function confirmed(h: H, email: string) {
  const r = await signup(h.stores, h.confirmSigner, h.clock, { orgId: ORG, email, listId: LIST });
  await confirmOptIn(h.stores, h.confirmSigner, h.clock, r.confirmationToken);
  return r.subscriber;
}
function send(h: H, campaignId: string) {
  return sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId,
    listId: LIST,
    subject: "x",
    template,
  });
}

test("recipientAllowedForDev: prod orgs and legacy records are never gated", () => {
  assert.equal(recipientAllowedForDev(undefined, "anyone@example.com"), true);
  assert.equal(recipientAllowedForDev({ environment: "prod" }, "anyone@example.com"), true);
  // No environment field (legacy) → treated as prod.
  assert.equal(recipientAllowedForDev({ devAllowlist: [] }, "anyone@example.com"), true);
});

test("recipientAllowedForDev: dev org matches exact emails and @domain suffixes, case-insensitively", () => {
  const org = { environment: "dev" as const, devAllowlist: ["QA@Team.test", "@allowed.test"] };
  assert.equal(recipientAllowedForDev(org, "qa@team.test"), true); // exact, case-folded
  assert.equal(recipientAllowedForDev(org, " someone@ALLOWED.test "), true); // domain suffix + trim
  assert.equal(recipientAllowedForDev(org, "someone@notallowed.test"), false);
  // A substring of the domain must not match — suffix is compared whole.
  assert.equal(recipientAllowedForDev(org, "x@evilallowed.test"), false);
});

test("recipientAllowedForDev: dev org with no allowlist is fail-closed", () => {
  assert.equal(recipientAllowedForDev({ environment: "dev" }, "qa@team.test"), false);
  assert.equal(recipientAllowedForDev({ environment: "dev", devAllowlist: [] }, "qa@team.test"), false);
});

test("dev org sends only to allowlisted recipients; the rest are devBlocked", async () => {
  const h = await harness(orgRecord({ environment: "dev", devAllowlist: ["qa@team.test"] }));
  await confirmed(h, "qa@team.test");
  await confirmed(h, "real-reader@example.com");

  const r = await send(h, "c1");
  assert.equal(r.sent, 1);
  assert.equal(r.devBlocked, 1);
  assert.equal(h.sender.sent.length, 1);
  assert.equal(h.sender.sent[0]!.to, "qa@team.test");
});

test("dev org with no allowlist sends to no one (fail-closed)", async () => {
  const h = await harness(orgRecord({ environment: "dev" }));
  await confirmed(h, "qa@team.test");
  const r = await send(h, "c1");
  assert.equal(r.sent, 0);
  assert.equal(r.devBlocked, 1);
  assert.equal(h.sender.sent.length, 0);
});

test("prod org ignores the allowlist and sends to everyone", async () => {
  const h = await harness(orgRecord({ environment: "prod", devAllowlist: ["qa@team.test"] }));
  await confirmed(h, "qa@team.test");
  await confirmed(h, "real-reader@example.com");
  const r = await send(h, "c1");
  assert.equal(r.sent, 2);
  assert.equal(r.devBlocked, 0);
});

test("sendToSubscriber (drip/transactional) honors the dev allowlist", async () => {
  const h = await harness(orgRecord({ environment: "dev", devAllowlist: ["@allowed.test"] }));
  const blocked = await confirmed(h, "reader@example.com");
  const allowed = await confirmed(h, "tester@allowed.test");

  const r1 = await sendToSubscriber(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "drip1",
    subscriberId: blocked.sub,
    listId: LIST,
    subject: "x",
    template,
  });
  assert.equal(r1.sent, false);
  assert.equal(r1.reason, "dev-allowlist");

  const r2 = await sendToSubscriber(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "drip2",
    subscriberId: allowed.sub,
    listId: LIST,
    subject: "x",
    template,
  });
  assert.equal(r2.sent, true);
});
