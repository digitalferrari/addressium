/**
 * #165 — the deliverability halt was decorative: checkDeliverability set
 *        Campaign.status = "halted" but nothing in the send path ever read it,
 *        so a halted campaign ran to completion.
 * #181 — the re-engagement sweep discarded sendToSubscriber's result, so a
 *        subscriber who was never actually emailed still advanced toward
 *        sunset (unsubscribe-from-all + suppress).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SystemClock, sendCampaign, memStores, CaptureSender } from "@addressium/domain";
import type { MagicLinkSigner } from "@addressium/domain";

const ORG = "acme";
const LIST = "ledger";
const magic: MagicLinkSigner = { mint: async () => "TOK" };

async function seed(n: number) {
  const stores = memStores();
  const clock = new SystemClock();
  await stores.lists.put({
    orgId: ORG, listId: LIST, name: "Ledger", optInPolicy: "double",
    fromAddress: "news@acme.example", access: "free", visibility: "open",
    complianceFooter: "footer", physicalAddress: "1 Main St",
  });
  for (let i = 0; i < n; i++) {
    const sub = `s${String(i).padStart(3, "0")}`;
    await stores.subscribers.put({
      orgId: ORG, sub, email: `r${i}@x.example`, status: "active",
      entitlement: "free", attributes: {},
    });
    await stores.subscriptions.put({
      orgId: ORG, subscriberId: sub, listId: LIST, status: "confirmed",
      updatedAt: clock.now().toISOString(),
    });
  }
  return { stores, clock };
}

const descriptor = {
  orgId: ORG, campaignId: "daily-1", listId: LIST, subject: "Hi",
  template: { blocks: [{ kind: "text" as const, html: "<p>hello</p>" }] },
};

test("a halted campaign sends to nobody", async () => {
  const { stores, clock } = await seed(5);
  await stores.campaigns.put({
    orgId: ORG, campaignId: "daily-1", subject: "Hi", status: "halted",
    type: "one_off", audience: { listId: LIST },
    counters: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 },
  } as never);

  const sender = new CaptureSender();
  const res = await sendCampaign(stores, sender, magic, clock, descriptor);
  assert.equal(res.halted, true, "reports the halt");
  assert.equal(res.sent, 0);
  assert.equal(sender.sent.length, 0, "no mail leaves while halted");
});

test("a campaign that is not halted still sends normally", async () => {
  const { stores, clock } = await seed(3);
  await stores.campaigns.put({
    orgId: ORG, campaignId: "daily-1", subject: "Hi", status: "sending",
    type: "one_off", audience: { listId: LIST },
    counters: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 },
  } as never);

  const sender = new CaptureSender();
  const res = await sendCampaign(stores, sender, magic, clock, descriptor);
  assert.equal(res.sent, 3);
  assert.notEqual(res.halted, true);
});

test("no campaign record means no halt gate (recurring editions still send)", async () => {
  const { stores, clock } = await seed(2);
  const sender = new CaptureSender();
  const res = await sendCampaign(stores, sender, magic, clock, {
    ...descriptor,
    campaignId: "daily-1-2026072713",
  });
  assert.equal(res.sent, 2);
});
