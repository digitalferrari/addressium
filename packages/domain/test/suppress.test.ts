/**
 * Unsubscribe and bounce/complaint auto-suppression: both must stop future sends.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "jose";
import type { List } from "@addressium/core";
import {
  memStores,
  CaptureSender,
  HmacConfirmationSigner,
  SystemClock,
  JoseMagicLinkSigner,
  buildConfirmationEmail,
  signup,
  confirmOptIn,
  sendCampaign,
  unsubscribeFromList,
  unsubscribeAll,
  recordBounce,
  recordComplaint,
  type EmailTemplate,
} from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";
const template: EmailTemplate = {
  blocks: [{ kind: "editorial", label: "read", url: "https://northwindtimes.example/a" }],
};

async function harness() {
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
    fromAddress: "l@northwindtimes.example",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "a",
  };
  await stores.lists.put(list);
  return { stores, sender, clock, confirmSigner, magic };
}

async function confirmedSubscriber(h: Awaited<ReturnType<typeof harness>>, email: string) {
  const r = await signup(h.stores, h.confirmSigner, h.clock, { orgId: ORG, email, listId: LIST });
  await confirmOptIn(h.stores, h.confirmSigner, h.clock, r.confirmationToken);
  return r.subscriber;
}

async function send(h: Awaited<ReturnType<typeof harness>>, campaignId: string) {
  return sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId,
    listId: LIST,
    subject: "x",
    template,
  });
}

test("per-list unsubscribe stops future sends to that list", async () => {
  const h = await harness();
  const s = await confirmedSubscriber(h, "jordan@example.com");
  assert.equal((await send(h, "c1")).sent, 1);

  await unsubscribeFromList(h.stores, h.clock, { orgId: ORG, subscriberId: s.sub, listId: LIST });
  h.sender.sent.length = 0;
  assert.equal((await send(h, "c2")).sent, 0);
});

test("unsubscribe-all flips every subscription and adds org suppression", async () => {
  const h = await harness();
  const s = await confirmedSubscriber(h, "jordan@example.com");
  const n = await unsubscribeAll(h.stores, h.clock, {
    orgId: ORG,
    subscriberId: s.sub,
    email: "jordan@example.com",
  });
  assert.ok(n >= 1);
  assert.equal(await h.stores.suppression.isSuppressed(ORG, "jordan@example.com"), true);
});

test("complaint auto-suppresses and the suppression gate drops future sends", async () => {
  const h = await harness();
  const s = await confirmedSubscriber(h, "angry@example.com");
  // A complaint without a specific list adds account-wide (global) suppression
  // but leaves the subscription 'confirmed' — so the send reaches the recipient
  // and the suppression gate is what drops it.
  await recordComplaint(h.stores, h.clock, {
    orgId: ORG,
    subscriberId: s.sub,
    email: "angry@example.com",
    campaignId: "c1",
  });
  assert.equal(await h.stores.suppression.isSuppressed(ORG, "angry@example.com"), true);
  const updated = await h.stores.subscribers.get(ORG, s.sub);
  assert.equal(updated?.status, "suppressed");
  assert.equal((await send(h, "c2")).suppressed, 1);
});

test("confirmation email carries the confirm link, from-address and footer", async () => {
  const h = await harness();
  const list = await h.stores.lists.get(ORG, LIST);
  assert.ok(list);
  const msg = buildConfirmationEmail(list!, "jordan@example.com", "https://s.example/confirm?token=abc");
  assert.equal(msg.to, "jordan@example.com");
  assert.equal(msg.from, "l@northwindtimes.example");
  assert.match(msg.html, /confirm\?token=abc/);
  assert.match(msg.subject, /Confirm your subscription/);
});

test("idempotent: the same campaign id is not dispatched twice", async () => {
  const h = await harness();
  await confirmedSubscriber(h, "jordan@example.com");
  assert.equal((await send(h, "dup1")).sent, 1);
  const second = await send(h, "dup1");
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, true);
});

test("global suppression applies across orgs; unsubscribe stays per-org", async () => {
  const h = await harness();
  const s = await confirmedSubscriber(h, "x@y.com");
  await recordComplaint(h.stores, h.clock, { orgId: ORG, subscriberId: s.sub, email: "x@y.com" });
  assert.equal(await h.stores.suppression.isSuppressed(ORG, "x@y.com"), true);
  assert.equal(await h.stores.suppression.isSuppressed("other-org", "x@y.com"), true); // global

  await h.stores.suppression.add({
    orgId: ORG,
    email: "z@y.com",
    source: "unsubscribe",
    scope: "org",
    addedAt: h.clock.now().toISOString(),
  });
  assert.equal(await h.stores.suppression.isSuppressed(ORG, "z@y.com"), true);
  assert.equal(await h.stores.suppression.isSuppressed("other-org", "z@y.com"), false); // per-org
});

test("bounce marks the subscription bounced and suppresses", async () => {
  const h = await harness();
  const s = await confirmedSubscriber(h, "gone@nowhere.test");
  await recordBounce(h.stores, h.clock, {
    orgId: ORG,
    subscriberId: s.sub,
    email: "gone@nowhere.test",
    listId: LIST,
  });
  const sub = await h.stores.subscriptions.get(ORG, s.sub, LIST);
  assert.equal(sub?.status, "bounced");
  assert.equal(await h.stores.suppression.isSuppressed(ORG, "gone@nowhere.test"), true);
});

test("a transient bounce is recorded but never suppresses (#211)", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  await stores.subscribers.put({
    orgId: ORG, sub: "s1", email: "full@x.example", status: "active",
    entitlement: "free", attributes: {},
  });

  for (const bounceType of ["Transient", "Undetermined"] as const) {
    const r = await recordBounce(stores, clock, {
      orgId: ORG, subscriberId: "s1", email: "full@x.example",
      campaignId: "c1", bounceType,
    });
    assert.equal(r.suppressed, false, `${bounceType} must not suppress`);
    assert.equal(await stores.suppression.isSuppressed(ORG, "full@x.example"), false);
    const s = await stores.subscribers.get(ORG, "s1");
    assert.equal(s?.status, "active", "subscriber stays mailable");
  }
  // ...but the soft bounce is still visible, not dropped.
  const events = await stores.events.all(ORG, "c1");
  assert.equal(events.filter((e) => e.type === "bounce").length, 2);
});

test("a permanent bounce still suppresses, and so does an unclassified one", async () => {
  for (const bounceType of ["Permanent", undefined] as const) {
    const stores = memStores();
    const clock = new SystemClock();
    await stores.subscribers.put({
      orgId: ORG, sub: "s1", email: "gone@x.example", status: "active",
      entitlement: "free", attributes: {},
    });
    const r = await recordBounce(stores, clock, {
      orgId: ORG, subscriberId: "s1", email: "gone@x.example", bounceType,
    });
    assert.equal(r.suppressed, true, `${bounceType ?? "unclassified"} must suppress`);
    assert.equal(await stores.suppression.isSuppressed(ORG, "gone@x.example"), true);
  }
});
