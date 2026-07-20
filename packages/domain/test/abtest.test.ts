/**
 * A/B subject test: holdouts split disjointly from the remainder, phase-1 sends
 * each subject to its holdout, the higher-engagement variant wins, and phase-2
 * sends the winning subject to the remainder exactly once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AbTest, List, Subscriber } from "@addressium/core";
import {
  memStores,
  CaptureSender,
  SystemClock,
  JoseMagicLinkSigner,
  planAbSplit,
  startAbTest,
  decideAbWinner,
  sendAbWinnerToRemainder,
  recordOpen,
  abCampaignId,
  type EmailTemplate,
} from "@addressium/domain";
import { generateKeyPair } from "jose";

const ORG = "summit";
const LIST = "ledger";
const template: EmailTemplate = { blocks: [{ kind: "text", html: "hi" }] };
const abTest: AbTest = {
  variantA: "Subject A",
  variantB: "Subject B",
  splitPct: 20,
  winnerMetric: "open",
  decisionWindowMins: 60,
};

async function harness(n: number) {
  const stores = memStores();
  const sender = new CaptureSender();
  const clock = new SystemClock();
  const { privateKey } = await generateKeyPair("ES256");
  const magic = new JoseMagicLinkSigner(
    { privateKey, kid: "k", issuer: "i", audience: "a", ttlSeconds: 60 },
    clock,
  );
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
  return { stores, sender, clock, magic };
}

test("planAbSplit halves the holdout and leaves disjoint remainder", () => {
  const split = planAbSplit(100, 20); // 20% test → 10 A + 10 B, 80 remainder
  assert.deepEqual(split.holdoutA, { offset: 0, limit: 10 });
  assert.deepEqual(split.holdoutB, { offset: 10, limit: 10 });
  assert.deepEqual(split.remainder, { offset: 20, limit: 80 });
});

test("phase 1 sends each subject to its holdout; winner takes the remainder", async () => {
  const h = await harness(100);
  const descriptor = { orgId: ORG, campaignId: "promo", listId: LIST, subject: "ignored", template };

  const { split, a, b } = await startAbTest(h.stores, h.sender, h.magic, h.clock, descriptor, abTest);
  assert.equal(a.sent, 10);
  assert.equal(b.sent, 10);
  const subjects = new Set(h.sender.sent.map((m) => m.subject));
  assert.deepEqual([...subjects].sort(), ["Subject A", "Subject B"]);

  // Make variant B the engagement winner: 3 opens on B's sub-campaign, 1 on A's.
  await recordOpen(h.stores, h.clock, ORG, abCampaignId("promo", "A"), "s0");
  await recordOpen(h.stores, h.clock, ORG, abCampaignId("promo", "B"), "s10");
  await recordOpen(h.stores, h.clock, ORG, abCampaignId("promo", "B"), "s11");
  await recordOpen(h.stores, h.clock, ORG, abCampaignId("promo", "B"), "s12");

  const decision = await decideAbWinner(h.stores, "promo", ORG, abTest);
  assert.equal(decision.winner, "B");
  assert.equal(decision.aScore, 1);
  assert.equal(decision.bScore, 3);

  h.sender.sent.length = 0;
  const remainder = await sendAbWinnerToRemainder(
    h.stores,
    h.sender,
    h.magic,
    h.clock,
    descriptor,
    abTest,
    split,
    decision.winner,
  );
  assert.equal(remainder.sent, 80);
  assert.ok(h.sender.sent.every((m) => m.subject === "Subject B"));
});

test("decideAbWinner breaks a tie toward A", async () => {
  const h = await harness(20);
  const descriptor = { orgId: ORG, campaignId: "tie", listId: LIST, subject: "x", template };
  await startAbTest(h.stores, h.sender, h.magic, h.clock, descriptor, abTest);
  const decision = await decideAbWinner(h.stores, "tie", ORG, abTest); // 0-0
  assert.equal(decision.winner, "A");
});
