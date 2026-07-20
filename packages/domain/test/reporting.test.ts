/**
 * Reporting: counters are derived from the event log (opens/clicks unique per
 * subscriber), deliverability rates are relative to sent, and the campaign
 * report bundles counters + rates + click map.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { EngagementEvent } from "@addressium/core";
import {
  deriveCounters,
  deliverabilityRates,
  buildCampaignReport,
  memStores,
  SystemClock,
} from "@addressium/domain";

const ORG = "summit";
const C = "camp-1";

function evt(type: EngagementEvent["type"], subscriberId: string): EngagementEvent {
  return { orgId: ORG, campaignId: C, subscriberId, type, at: "2026-07-20T00:00:00Z" };
}

test("deriveCounters counts sent raw and opens/clicks unique per subscriber", () => {
  const c = deriveCounters([
    evt("sent", "a"),
    evt("sent", "b"),
    evt("open", "a"),
    evt("open", "a"), // duplicate open by same subscriber → still 1 unique
    evt("click", "a"),
    evt("bounce", "b"),
    evt("complaint", "b"),
  ]);
  assert.equal(c.sent, 2);
  assert.equal(c.opens, 1);
  assert.equal(c.clicks, 1);
  assert.equal(c.bounces, 1);
  assert.equal(c.complaints, 1);
});

test("deliverabilityRates are fractions of sent and 0 when nothing sent", () => {
  const r = deliverabilityRates({
    sent: 4,
    delivered: 4,
    opens: 2,
    clicks: 1,
    bounces: 1,
    complaints: 0,
    unsubscribes: 0,
  });
  assert.equal(r.openRate, 0.5);
  assert.equal(r.bounceRate, 0.25);
  const empty = deliverabilityRates({
    sent: 0,
    delivered: 0,
    opens: 0,
    clicks: 0,
    bounces: 0,
    complaints: 0,
    unsubscribes: 0,
  });
  assert.equal(empty.openRate, 0);
});

test("buildCampaignReport bundles counters, rates and the click map", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  for (const e of [evt("sent", "a"), evt("sent", "b"), evt("open", "a"), evt("click", "a")]) {
    await stores.events.append(e);
  }
  const report = await buildCampaignReport(stores, ORG, C);
  assert.equal(report.counters.sent, 2);
  assert.equal(report.counters.opens, 1);
  assert.equal(report.rates.openRate, 0.5);
  assert.equal(report.clickMap.sent, 2);
});
