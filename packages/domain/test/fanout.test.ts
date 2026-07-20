/**
 * SQS fan-out: a large list is split into sliced descriptors on the queue, each
 * slice sends only its window, per-slice idempotency prevents double-sends, and
 * the union of slices covers every confirmed recipient exactly once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { List, Subscriber } from "@addressium/core";
import {
  memStores,
  CaptureSender,
  MemSendQueue,
  SystemClock,
  JoseMagicLinkSigner,
  fanOutCampaign,
  sendCampaign,
  type EmailTemplate,
} from "@addressium/domain";
import { generateKeyPair } from "jose";

const ORG = "summit";
const LIST = "ledger";
const template: EmailTemplate = { blocks: [{ kind: "text", html: "hi" }] };

async function seed(n: number) {
  const stores = memStores();
  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "Ledger",
    optInPolicy: "single",
    fromAddress: "l@northwindtimes.example",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "a",
  };
  await stores.lists.put(list);
  for (let i = 0; i < n; i++) {
    const sub: Subscriber = {
      orgId: ORG,
      sub: `s${i}`,
      email: `s${i}@x.com`,
      attributes: {},
      status: "active",
      entitlement: "free",
    };
    await stores.subscribers.put(sub);
    await stores.subscriptions.put({
      orgId: ORG,
      subscriberId: `s${i}`,
      listId: LIST,
      status: "confirmed",
      updatedAt: "t",
    });
  }
  return stores;
}

const descriptor = { orgId: ORG, campaignId: "big", listId: LIST, subject: "s", template };

test("fanOutCampaign enqueues one sliced message per window for a large list", async () => {
  const stores = await seed(25);
  const queue = new MemSendQueue();
  const slices = await fanOutCampaign(stores, queue, descriptor, 10);
  assert.equal(slices.length, 3); // 10 + 10 + 5
  assert.equal(queue.enqueued.length, 3);
  assert.deepEqual(queue.enqueued[0]?.slice, { offset: 0, limit: 10 });
  assert.deepEqual(queue.enqueued[2]?.slice, { offset: 20, limit: 5 });
});

test("a list that fits in one chunk is not fanned out", async () => {
  const stores = await seed(5);
  const queue = new MemSendQueue();
  const slices = await fanOutCampaign(stores, queue, descriptor, 10);
  assert.equal(slices.length, 0);
  assert.equal(queue.enqueued.length, 0);
});

test("slices cover every recipient exactly once, and re-delivery is idempotent", async () => {
  const stores = await seed(25);
  const sender = new CaptureSender();
  const clock = new SystemClock();
  const { privateKey } = await generateKeyPair("ES256");
  const magic = new JoseMagicLinkSigner(
    { privateKey, kid: "k", issuer: "i", audience: "a", ttlSeconds: 60 },
    clock,
  );
  const slices = planWindows(25, 10);

  let total = 0;
  for (const slice of slices) {
    const r = await sendCampaign(stores, sender, magic, clock, { ...descriptor, slice }, {});
    total += r.sent;
  }
  assert.equal(total, 25); // full coverage, no overlap
  assert.equal(new Set(sender.sent.map((m) => m.to)).size, 25);

  // Re-deliver slice 0 (SQS at-least-once) → skipped by per-slice claim.
  const dup = await sendCampaign(
    stores,
    sender,
    magic,
    clock,
    { ...descriptor, slice: { offset: 0, limit: 10 } },
    {},
  );
  assert.equal(dup.skipped, true);
  assert.equal(dup.sent, 0);
});

function planWindows(total: number, chunk: number) {
  const out = [];
  for (let offset = 0; offset < total; offset += chunk) {
    out.push({ offset, limit: Math.min(chunk, total - offset) });
  }
  return out;
}
