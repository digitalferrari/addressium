/**
 * Campaign counters (#221, compendium #57).
 *
 * `HotCounters` was declared, preserved across draft saves, and never
 * incremented by anything — so the console showed `sent: 0`, every persisted
 * `UsageRecord` billed zero emails, and the deliverability gate re-folded the
 * whole event log on every bounce.
 *
 * The counter now moves with the event append, made exactly-once by the
 * deterministic `eventId`. That property is the point: since the event plane
 * moved to SQS (#218) at-least-once redelivery is GUARANTEED, so a bare
 * increment would double-count. An inflated bounce count halts a healthy
 * campaign; a lost one lets a bad campaign run.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Campaign, EngagementEvent } from "@addressium/core";
import { memStores, sumEmailsSent, type Stores } from "@addressium/domain";

const ORG = "summit";
const C = "camp-1";

const campaign = (): Campaign => ({
  orgId: ORG,
  campaignId: C,
  type: "one_off",
  subject: "s",
  templateId: "t",
  audience: { listId: "l" },
  status: "sending",
  counters: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 },
});

const ev = (
  type: EngagementEvent["type"],
  subscriberId: string,
  eventId?: string,
): EngagementEvent => ({ orgId: ORG, campaignId: C, subscriberId, type, at: "2026-01-01T00:00:00Z", eventId });

async function seeded(): Promise<Stores> {
  const stores = memStores();
  await stores.campaigns.put(campaign());
  return stores;
}

const counters = async (stores: Stores) => (await stores.campaigns.get(ORG, C))?.counters;

test("an append moves the campaign's counter", async () => {
  const stores = await seeded();
  await stores.events.append(ev("sent", "s1", "e1"));
  await stores.events.append(ev("sent", "s2", "e2"));
  await stores.events.append(ev("bounce", "s3", "e3"));

  const c = await counters(stores);
  assert.equal(c?.sent, 2);
  assert.equal(c?.bounces, 1);
  assert.equal(c?.complaints, 0);
});

test("replaying the same event N times leaves counters identical to one delivery", async () => {
  const stores = await seeded();
  // The exact redelivery SQS will now produce, repeatedly.
  for (let i = 0; i < 5; i++) await stores.events.append(ev("bounce", "s1", "bounce-1"));

  assert.equal((await counters(stores))?.bounces, 1, "at-least-once delivery must not inflate the count");
  assert.equal((await stores.events.all(ORG, C)).length, 1, "and must not duplicate the event row");
});

test("a repeat open by the SAME subscriber is recorded but counted once", async () => {
  const stores = await seeded();
  await stores.events.append(ev("open", "s1", "open-1"));
  await stores.events.append(ev("open", "s1", "open-2")); // genuinely opened twice

  // `opens` counts PEOPLE (deriveCounters uses a Set of subscriberIds), so a
  // second open by the same reader is real history but not a second unique open.
  assert.equal((await counters(stores))?.opens, 1);
  assert.equal((await stores.events.all(ORG, C)).length, 2, "both opens are kept as history");
});

test("opens by different subscribers each count", async () => {
  const stores = await seeded();
  await stores.events.append(ev("open", "s1", "o1"));
  await stores.events.append(ev("open", "s2", "o2"));
  await stores.events.append(ev("click", "s1", "c1"));

  const c = await counters(stores);
  assert.equal(c?.opens, 2);
  assert.equal(c?.clicks, 1);
});

test("every event type maps to its own counter", async () => {
  const stores = await seeded();
  const types: EngagementEvent["type"][] = [
    "sent",
    "delivered",
    "open",
    "click",
    "bounce",
    "complaint",
    "unsubscribe",
  ];
  for (const [i, t] of types.entries()) await stores.events.append(ev(t, `s${i}`, `id-${i}`));

  assert.deepEqual(await counters(stores), {
    sent: 1,
    delivered: 1,
    opens: 1,
    clicks: 1,
    bounces: 1,
    complaints: 1,
    unsubscribes: 1,
  });
});

test("sumEmailsSent returns the real send count, not zero", async () => {
  const stores = await seeded();
  for (let i = 0; i < 250; i++) await stores.events.append(ev("sent", `s${i}`, `sent-${i}`));

  const campaigns = await stores.campaigns.list(ORG);
  // Every persisted UsageRecord billed 0 emails before this, because
  // sumEmailsSent reads counters.sent and nothing ever moved it.
  assert.equal(sumEmailsSent(campaigns), 250);
});

test("an event for a campaign that does not exist does not resurrect one", async () => {
  const stores = memStores(); // no campaign put
  await stores.events.append(ev("sent", "s1", "e1"));

  assert.equal(await stores.campaigns.get(ORG, C), undefined);
  assert.equal((await stores.events.all(ORG, C)).length, 1, "the event is still recorded");
});

test("counters survive a draft edit", async () => {
  const stores = await seeded();
  for (let i = 0; i < 3; i++) await stores.events.append(ev("sent", `s${i}`, `e${i}`));

  const existing = await stores.campaigns.get(ORG, C);
  await stores.campaigns.put({ ...existing!, subject: "edited" });

  assert.equal((await counters(stores))?.sent, 3);
});

test("interleaved redeliveries across types stay exact", async () => {
  const stores = await seeded();
  const script: Array<[EngagementEvent["type"], string, string]> = [
    ["sent", "s1", "a"],
    ["open", "s1", "b"],
    ["sent", "s1", "a"], // redelivery
    ["click", "s1", "c"],
    ["open", "s1", "b"], // redelivery
    ["open", "s2", "d"], // different person
    ["click", "s1", "c"], // redelivery
  ];
  for (const [t, s, id] of script) await stores.events.append(ev(t, s, id));

  const c = await counters(stores);
  assert.equal(c?.sent, 1);
  assert.equal(c?.opens, 2, "two distinct people opened");
  assert.equal(c?.clicks, 1);
});
