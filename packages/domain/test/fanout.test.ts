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
  planFanOut,
  sendCampaign,
  type EmailTemplate,
  type Stores,
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

  // Key ranges, not offsets (#171). Asserted structurally: the first window is
  // open at the bottom, the last is open at the top so a late confirmation is
  // still picked up, and each window's lower bound is the previous one's upper
  // bound so the ranges are contiguous and disjoint.
  assert.equal(slices[0]?.after, undefined, "first window is open at the bottom");
  assert.equal(slices[2]?.until, undefined, "last window is open at the top");
  assert.equal(slices[1]?.after, slices[0]?.until);
  assert.equal(slices[2]?.after, slices[1]?.until);
  assert.deepEqual(queue.enqueued.map((m) => m.slice), slices);
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
  const slices = await planWindows(stores, descriptor.orgId, descriptor.listId, 10);

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
    { ...descriptor, slice: slices[0]! },
    {},
  );
  assert.equal(dup.skipped, true);
  assert.equal(dup.sent, 0);
});

/**
 * Plan windows the way fan-out does: from the ORDERED subscriber ids, as key
 * ranges. A local offset/limit helper would test a scheme the product no longer
 * uses (#171).
 */
async function planWindows(stores: Stores, orgId: string, listId: string, chunk: number) {
  const confirmed = await stores.subscriptions.listConfirmed(orgId, listId);
  return planFanOut(
    [...confirmed].sort((a, b) => a.subscriberId.localeCompare(b.subscriberId)).map((c) => c.subscriberId),
    chunk,
  );
}

/**
 * The bug this scheme exists to prevent (#171).
 *
 * With numeric offsets, slices were planned at T0 and each re-read the confirmed
 * set at T1..Tn, re-slicing by an index computed against a set that had since
 * moved. Subscriber ids sort lexicographically in DynamoDB, so a new signup
 * lands at a RANDOM position and shifts every later index by one:
 *
 *   - an unsubscribe before a window pulls the boundary back → someone is
 *     NEVER SENT;
 *   - a confirmation before a window pushes it forward → someone is SENT TWICE.
 *
 * Both are silent. The recipient set is simply wrong and nothing reports it.
 */
async function deliverAllSlices(
  stores: Stores,
  slices: Awaited<ReturnType<typeof fanOutCampaign>>,
  mutate?: (i: number) => Promise<void>,
): Promise<string[]> {
  const { privateKey } = await generateKeyPair("ES256");
  const clock = new SystemClock();
  const magic = new JoseMagicLinkSigner(
    { privateKey, kid: "k", issuer: "i", audience: "a", ttlSeconds: 60 },
    clock,
  );
  const sender = new CaptureSender();
  for (const [i, slice] of slices.entries()) {
    // The mutation lands BETWEEN slices — exactly the interleaving that broke
    // offset slicing.
    if (mutate) await mutate(i);
    await sendCampaign(
      stores,
      sender,
      magic,
      clock,
      { ...descriptor, campaignId: `c${i}`, slice },
      {},
    );
  }
  return sender.sent.map((m) => m.to);
}

test("an unsubscribe mid-fan-out does not cause anyone to be skipped", async () => {
  const stores = await seed(25);
  const queue = new MemSendQueue();
  const slices = await fanOutCampaign(stores, queue, descriptor, 10);

  const sent = await deliverAllSlices(stores, slices, async (i) => {
    if (i !== 1) return;
    // Someone in an ALREADY-SENT window unsubscribes. Under offsets this pulled
    // every later index back by one and the last recipient of the previous
    // window fell through the gap.
    await stores.subscriptions.put({
      orgId: ORG,
      subscriberId: "s0",
      listId: LIST,
      status: "unsubscribed",
      updatedAt: "t2",
    });
  });

  // 25, not 24: `s0` sorts into the FIRST window, which was already delivered
  // before the unsubscribe landed. Being mailed a campaign you were confirmed
  // for at the moment it reached you is correct.
  //
  // What matters is what happens to everyone AFTER them. Under offset slicing
  // this unsubscribe pulled every later index back by one, and the last
  // recipient of the previous window silently fell through the gap.
  assert.equal(new Set(sent).size, sent.length, "no duplicates");
  assert.equal(sent.length, 25, "nobody after the unsubscriber was skipped");
  for (let i = 0; i < 25; i++) {
    assert.ok(sent.includes(`s${i}@x.com`), `s${i} fell through the gap`);
  }
});

test("a confirmation mid-fan-out does not cause anyone to be mailed twice", async () => {
  const stores = await seed(25);
  const queue = new MemSendQueue();
  const slices = await fanOutCampaign(stores, queue, descriptor, 10);

  const sent = await deliverAllSlices(stores, slices, async (i) => {
    if (i !== 1) return;
    // A new confirmation sorting into the MIDDLE of the set — "s05" lands
    // between "s0" and "s1" lexicographically, shifting every later index.
    await stores.subscribers.put({
      orgId: ORG,
      sub: "s05",
      email: "s05@x.com",
      attributes: {},
      status: "active",
      entitlement: "free",
    });
    await stores.subscriptions.put({
      orgId: ORG,
      subscriberId: "s05",
      listId: LIST,
      status: "confirmed",
      updatedAt: "t2",
    });
  });

  assert.equal(new Set(sent).size, sent.length, "nobody was mailed twice");
  // The original 25 all land. The late arrival falls in whichever window still
  // contains its key — it is not double-sent and not required to be sent.
  for (let i = 0; i < 25; i++) {
    assert.ok(sent.includes(`s${i}@x.com`), `s${i} was skipped`);
  }
});

test("the windows tile the whole set exactly once", async () => {
  // The property that makes skips and duplicates impossible: ranges are
  // disjoint and contiguous, and the last one is open-ended.
  const stores = await seed(25);
  const queue = new MemSendQueue();
  const slices = await fanOutCampaign(stores, queue, descriptor, 10);
  const confirmed = await stores.subscriptions.listConfirmed(ORG, LIST);
  const ids = confirmed.map((c) => c.subscriberId).sort((a, b) => a.localeCompare(b));

  const covered = ids.map(
    (id) =>
      slices.filter(
        (s) => (s.after === undefined || id > s.after) && (s.until === undefined || id <= s.until),
      ).length,
  );
  assert.deepEqual([...new Set(covered)], [1], "every id is in exactly one window");
});
