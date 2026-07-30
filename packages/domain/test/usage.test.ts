/**
 * Usage & cost metering: the cost model applies per-email / per-GB-month /
 * per-dedicated-IP rates, sumEmailsSent rolls up campaign counters, and
 * recordUsage persists a costed record retrievable per org/period.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Campaign, CostRates, EngagementEvent } from "@addressium/core";
import {
  estimateCost,
  sumEmailsSent,
  emailsSentInPeriod,
  meterOrgUsage,
  recordUsage,
  usagePeriodOf,
  DEFAULT_COST_RATES,
  memStores,
  SystemClock,
} from "@addressium/domain";

const rates: CostRates = { perEmail: 0.0001, perGbStorageMonth: 0.023, perDedicatedIpMonth: 24.95, perTbScanned: 5.0 };

test("estimateCost applies each rate and totals them", () => {
  const cost = estimateCost(
    { orgId: "o", period: "2026-07", emailsSent: 1_000_000, storageBytes: 2 * 1_073_741_824, dedicatedIps: 2 },
    rates,
  );
  assert.equal(cost.email, 100); // 1M * 0.0001
  assert.ok(Math.abs(cost.storage - 0.046) < 1e-9); // 2 GB * 0.023
  assert.equal(cost.dedicatedIp, 49.9); // 2 * 24.95
  assert.equal(cost.athena, 0); // no scan reported
  assert.ok(Math.abs(cost.total - (100 + 0.046 + 49.9)) < 1e-9);
});

test("estimateCost charges Athena per TB scanned", () => {
  const cost = estimateCost(
    { orgId: "o", period: "2026-07", emailsSent: 0, storageBytes: 0, dedicatedIps: 0, athenaBytesScanned: 2 * 1_099_511_627_776 },
    rates,
  );
  assert.equal(cost.athena, 10); // 2 TB * $5
  assert.equal(cost.total, 10);
});

test("sumEmailsSent rolls up campaign hot counters", () => {
  const mk = (sent: number): Campaign => ({
    orgId: "o",
    campaignId: `c${sent}`,
    type: "one_off",
    subject: "s",
    templateId: "t",
    audience: {},
    status: "sent",
    counters: { sent, delivered: sent, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0 },
  });
  assert.equal(sumEmailsSent([mk(100), mk(250)]), 350);
});

test("recordUsage persists a costed record retrievable by org/period", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  const record = await recordUsage(
    stores,
    clock,
    { orgId: "summit", period: "2026-07", emailsSent: 50_000, storageBytes: 1_073_741_824, dedicatedIps: 0 },
    DEFAULT_COST_RATES,
  );
  assert.equal(record.cost.email, 5); // 50k * 0.0001
  const fetched = await stores.usage.get("summit", "2026-07");
  assert.deepEqual(fetched, record);
  const history = await stores.usage.listByOrg("summit");
  assert.equal(history.length, 1);
});

// ---- period-scoped metering (#199) ----
//
// The Usage screen read a permanent $0 because nothing ever wrote a record.
// Fixing that introduced a second writer, and the failure mode of two writers on
// one row is that each erases the other's half — which is what most of these
// tests are about.

test("emailsSentInPeriod counts only `sent` events inside the month", () => {
  const ev = (type: EngagementEvent["type"], at: string): EngagementEvent => ({
    orgId: "o",
    campaignId: "c",
    subscriberId: "s",
    type,
    at,
  });
  const events = [
    ev("sent", "2026-06-30T23:59:59.000Z"), // previous month
    ev("sent", "2026-07-01T00:00:00.000Z"),
    ev("sent", "2026-07-31T23:59:59.999Z"),
    ev("sent", "2026-08-01T00:00:00.000Z"), // next month
    ev("open", "2026-07-15T00:00:00.000Z"), // not a send
    ev("delivered", "2026-07-15T00:00:00.000Z"),
  ];
  assert.equal(emailsSentInPeriod(events, "2026-07"), 2);
});

test("metering is per-period, not the lifetime counter", async () => {
  // sumEmailsSent folds campaign counters, which are LIFETIME totals: billed
  // monthly it charges for every email the org has ever sent, again, every
  // month. The event log is the only thing carrying a timestamp per send.
  const stores = memStores();
  const clock = new SystemClock();
  await stores.campaigns.put({
    orgId: "summit",
    campaignId: "c1",
    type: "one_off",
    subject: "s",
    templateId: "t",
    audience: {},
    status: "sent",
    counters: { sent: 500, delivered: 500, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0 },
  });
  for (const at of ["2026-06-20T00:00:00.000Z", "2026-07-02T00:00:00.000Z", "2026-07-03T00:00:00.000Z"]) {
    await stores.events.append({ orgId: "summit", campaignId: "c1", subscriberId: `s-${at}`, type: "sent", at });
  }
  const july = await meterOrgUsage(stores, clock, "summit", "2026-07");
  assert.equal(july.emailsSent, 2);
  assert.notEqual(july.emailsSent, 500); // the lifetime counter
  const june = await meterOrgUsage(stores, clock, "summit", "2026-06");
  assert.equal(june.emailsSent, 1);
});

test("the scheduled meter does NOT erase the operator's AWS-side figures", async () => {
  // The two writers know different halves. A nightly job that wrote
  // `storageBytes: 0` would wipe the operator's real numbers every night and put
  // the screen back to $0 — the same defect, now running on a schedule.
  const stores = memStores();
  const clock = new SystemClock();
  await recordUsage(stores, clock, {
    orgId: "summit",
    period: "2026-07",
    emailsSent: 0,
    storageBytes: 5 * 1_073_741_824,
    dedicatedIps: 2,
    athenaBytesScanned: 1_099_511_627_776,
  });
  await stores.campaigns.put({
    orgId: "summit",
    campaignId: "c1",
    type: "one_off",
    subject: "s",
    templateId: "t",
    audience: {},
    status: "sent",
    counters: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0 },
  });
  await stores.events.append({
    orgId: "summit",
    campaignId: "c1",
    subscriberId: "s1",
    type: "sent",
    at: "2026-07-04T00:00:00.000Z",
  });

  const after = await meterOrgUsage(stores, clock, "summit", "2026-07");
  assert.equal(after.emailsSent, 1, "our own half is refreshed");
  assert.equal(after.storageBytes, 5 * 1_073_741_824, "the operator's half survived");
  assert.equal(after.dedicatedIps, 2);
  assert.equal(after.athenaBytesScanned, 1_099_511_627_776);
  assert.ok(after.cost.storage > 0 && after.cost.athena > 0, "and is still costed");
});

test("usagePeriodOf reads the UTC month off an instant", () => {
  assert.equal(usagePeriodOf("2026-07-04T12:00:00.000Z"), "2026-07");
  assert.equal(usagePeriodOf("2026-12-31T23:59:59.999Z"), "2026-12");
});
