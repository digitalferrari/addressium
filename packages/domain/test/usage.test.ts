/**
 * Usage & cost metering: the cost model applies per-email / per-GB-month /
 * per-dedicated-IP rates, sumEmailsSent rolls up campaign counters, and
 * recordUsage persists a costed record retrievable per org/period.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Campaign, CostRates } from "@addressium/core";
import {
  estimateCost,
  sumEmailsSent,
  recordUsage,
  DEFAULT_COST_RATES,
  memStores,
  SystemClock,
} from "@addressium/domain";

const rates: CostRates = { perEmail: 0.0001, perGbStorageMonth: 0.023, perDedicatedIpMonth: 24.95 };

test("estimateCost applies each rate and totals them", () => {
  const cost = estimateCost(
    { orgId: "o", period: "2026-07", emailsSent: 1_000_000, storageBytes: 2 * 1_073_741_824, dedicatedIps: 2 },
    rates,
  );
  assert.equal(cost.email, 100); // 1M * 0.0001
  assert.ok(Math.abs(cost.storage - 0.046) < 1e-9); // 2 GB * 0.023
  assert.equal(cost.dedicatedIp, 49.9); // 2 * 24.95
  assert.ok(Math.abs(cost.total - (100 + 0.046 + 49.9)) < 1e-9);
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
    counters: { sent, delivered: sent, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 },
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
