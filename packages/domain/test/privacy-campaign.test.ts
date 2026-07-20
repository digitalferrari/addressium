/**
 * GDPR export/erase (+ suppression tombstone enforced by signup) and the
 * campaign/series store round-trips.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Campaign, CampaignSeries, List } from "@addressium/core";
import {
  memStores,
  HmacConfirmationSigner,
  SystemClock,
  confirmOptIn,
  eraseSubscriber,
  exportSubscriber,
  signup,
} from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";

async function seed() {
  const stores = memStores();
  const clock = new SystemClock();
  const confirmSigner = new HmacConfirmationSigner("secret");
  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "l@x.com",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "a",
  };
  await stores.lists.put(list);
  return { stores, clock, confirmSigner };
}

test("export returns the record; erase anonymizes + blocks re-signup", async () => {
  const { stores, clock, confirmSigner } = await seed();
  const r = await signup(stores, confirmSigner, clock, {
    orgId: ORG,
    email: "jordan@example.com",
    listId: LIST,
    attributes: { first_name: "Jordan" },
  });
  await confirmOptIn(stores, confirmSigner, clock, r.confirmationToken);

  const exp = await exportSubscriber(stores, ORG, "jordan@example.com");
  assert.equal(exp?.subscriber.sub, r.subscriber.sub);
  assert.equal(exp?.subscriptions.length, 1);

  assert.equal(await eraseSubscriber(stores, clock, ORG, "jordan@example.com"), true);
  const after = await stores.subscribers.get(ORG, r.subscriber.sub);
  assert.equal(after?.status, "suppressed");
  assert.match(after?.email ?? "", /^erased:/);
  assert.equal(Object.keys(after?.attributes ?? {}).length, 0);

  // Re-signup with the erased address is blocked by the tombstone.
  await assert.rejects(
    () => signup(stores, confirmSigner, clock, { orgId: ORG, email: "jordan@example.com", listId: LIST }),
    /suppressed/,
  );
});

test("campaign and series stores round-trip", async () => {
  const { stores } = await seed();
  const series: CampaignSeries = {
    orgId: ORG,
    seriesId: "s1",
    name: "Ledger daily",
    cadence: "daily",
    templateId: "t1",
    adSlotFills: [],
    aggregate: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 },
  };
  await stores.series.put(series);
  assert.equal((await stores.series.get(ORG, "s1"))?.cadence, "daily");

  const campaign: Campaign = {
    orgId: ORG,
    campaignId: "c1",
    type: "series_edition",
    seriesId: "s1",
    subject: "x",
    templateId: "t1",
    audience: { listId: LIST },
    status: "draft",
    counters: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 },
  };
  await stores.campaigns.put(campaign);
  assert.equal((await stores.campaigns.get(ORG, "c1"))?.status, "draft");
});
