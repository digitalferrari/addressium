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
    counters: counters({}),
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
});

test("checkDeliverability is a no-op when the org has no alert config", async () => {
  const stores = memStores();
  const publisher = new CaptureAlertPublisher();
  const result = await checkDeliverability(stores, publisher, new SystemClock(), ORG, C);
  assert.equal(result.breaches.length, 0);
  assert.equal(publisher.published.length, 0);
});
