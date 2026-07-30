/**
 * Deliverability alerts: threshold evaluation yields warn/halt breaches, and
 * checkDeliverability publishes to SNS + halts the campaign on a halt breach.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AlertConfig, Campaign, EngagementEvent, HotCounters } from "@addressium/core";
import {
  evaluateAlerts,
  checkDeliverability,
  memStores,
  CaptureAlertPublisher,
  SystemClock,
} from "@addressium/domain";

const ORG = "summit";
const C = "camp-1";

const config: AlertConfig = {
  orgId: ORG,
  snsTopicArn: "arn:aws:sns:us-east-1:123:deliverability",
  rules: [
    { metric: "complaint_rate", warnAt: 0.001, haltAt: 0.005, enabled: true },
    { metric: "bounce_rate", warnAt: 0.02, haltAt: 0.05, enabled: true },
    { metric: "reputation", warnAt: 0.1, haltAt: 0.2, enabled: false },
  ],
  notifyTargets: ["ops@northwindtimes.example"],
};

const counters = (over: Partial<HotCounters>): HotCounters => ({
  sent: 1000,
  delivered: 1000,
  opens: 0,
  clicks: 0,
  bounces: 0,
  complaints: 0,
  unsubscribes: 0,
  rejects: 0,
  renderingFailures: 0,
  deliveryDelays: 0,
  ...over,
});

test("evaluateAlerts flags warn below halt and halt at/above haltAt", () => {
  const warn = evaluateAlerts(config, counters({ complaints: 2 })); // 0.002 rate
  assert.equal(warn.length, 1);
  assert.equal(warn[0]?.level, "warn");

  const halt = evaluateAlerts(config, counters({ complaints: 6 })); // 0.006 rate
  assert.equal(halt[0]?.level, "halt");

  // disabled rule never fires
  assert.equal(evaluateAlerts(config, counters({})).length, 0);
});

test("checkDeliverability publishes to SNS and halts the campaign on a halt breach", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  const publisher = new CaptureAlertPublisher();
  await stores.alerts.put(config);

  const campaign: Campaign = {
    orgId: ORG,
    campaignId: C,
    type: "one_off",
    subject: "s",
    templateId: "t",
    audience: { listId: "l" },
    status: "sending",
    // Start at zero: appending an event now maintains the counters
    // transactionally (#221), so pre-seeding them here would double-count.
    counters: counters({ sent: 0, delivered: 0 }),
  };
  await stores.campaigns.put(campaign);

  // 1000 sent, 6 complaints → 0.6% > 0.5% halt threshold
  for (let i = 0; i < 1000; i++) {
    const e: EngagementEvent = { orgId: ORG, campaignId: C, subscriberId: `s${i}`, type: "sent", at: "t" };
    await stores.events.append(e);
  }
  for (let i = 0; i < 6; i++) {
    const e: EngagementEvent = { orgId: ORG, campaignId: C, subscriberId: `s${i}`, type: "complaint", at: "t" };
    await stores.events.append(e);
  }

  const result = await checkDeliverability(stores, publisher, clock, ORG, C);
  assert.equal(result.halted, true);
  assert.equal(publisher.published.length, 1);
  assert.equal(publisher.published[0]?.message.action, "halted");
  const after = await stores.campaigns.get(ORG, C);
  assert.equal(after?.status, "halted");
  // The counters the gate read were maintained by the appends themselves, not
  // derived by folding the event log on every bounce (#221, #182).
  assert.equal(after?.counters?.sent, 1000);
  assert.equal(after?.counters?.complaints, 6);
});

test("checkDeliverability is a no-op when the org has no alert config", async () => {
  const stores = memStores();
  const publisher = new CaptureAlertPublisher();
  const result = await checkDeliverability(stores, publisher, new SystemClock(), ORG, C);
  assert.equal(result.breaches.length, 0);
  assert.equal(publisher.published.length, 0);
});

test("checkDeliverability records a halt marker when the send id has NO campaign record", async () => {
  // Recurring-series editions (`<base>-<editionKey>`), drip sub-campaigns and
  // re-engagement steps send under ids with no CAMPAIGN row: their counters
  // are folded from the event log, and the halt cannot live on Campaign.status
  // — without a marker it was silently dropped, so a complaint storm could
  // never stop a series.
  const stores = memStores();
  const clock = new SystemClock();
  const publisher = new CaptureAlertPublisher();
  await stores.alerts.put(config);
  const EDITION = "daily-1-2026072713";

  // 100 sent, 1 complaint → 1% > 0.5% halt threshold, counters folded from the
  // event log because there is no campaign row to read them from.
  for (let i = 0; i < 100; i++) {
    await stores.events.append({ orgId: ORG, campaignId: EDITION, subscriberId: `s${i}`, type: "sent", at: "t" });
  }
  await stores.events.append({ orgId: ORG, campaignId: EDITION, subscriberId: "s0", type: "complaint", at: "t" });

  const result = await checkDeliverability(stores, publisher, clock, ORG, EDITION);
  assert.equal(result.halted, true);
  assert.equal(publisher.published[0]?.message.action, "halted");
  assert.equal(await stores.halts.isHalted(ORG, EDITION), true, "the halt is persisted");
  assert.equal(await stores.campaigns.get(ORG, EDITION), undefined, "no phantom campaign row is created");
});
