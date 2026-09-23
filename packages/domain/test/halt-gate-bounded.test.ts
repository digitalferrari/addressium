/**
 * Deliberability evaluation must not fold the event log (#293 item 3).
 *
 * `checkDeliverability` runs on EVERY bounce and complaint. For a send id with
 * no campaign record — drip steps, re-engagement steps — it fell back to
 * `deriveCounters(await stores.events.all(...))`, so the cost of one check grew
 * with the campaign's own event history: worst exactly when a campaign is
 * generating the most events.
 *
 * Measured before the fix: 500 events appended, one check folded all 500.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SystemClock, memStores, checkDeliverability, defaultAlertConfig } from "@addressium/domain";
import type { Stores } from "@addressium/domain";
import type { HotCounters } from "@addressium/core";

const ORG = "acme";
/** The id shape drip and re-engagement mint: a send with no campaign record. */
const RECORD_LESS = "reengage:ledger:1:2026-01-01T00:00:00.000Z";

/** Wraps memStores with a counting `events.all` and a `sendIdCounters` impl. */
function instrumented(counters?: HotCounters) {
  const stores = memStores() as Stores & { folds: number };
  stores.folds = 0;
  const realAll = stores.events.all.bind(stores.events);
  stores.events.all = async (o: string, c: string) => {
    stores.folds++;
    return realAll(o, c);
  };
  if (counters) stores.sendIdCounters = async () => counters;
  return stores;
}

const zero: HotCounters = {
  sent: 100, delivered: 98, opens: 0, clicks: 0, bounces: 1, complaints: 0,
  unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0,
};

test("a record-less id reads stored counters instead of folding events", async () => {
  const stores = instrumented(zero);
  const clock = new SystemClock();
  await stores.alerts.put(defaultAlertConfig(ORG));
  for (let i = 0; i < 50; i++) {
    await stores.events.append({
      orgId: ORG, subscriberId: `s${i}`, campaignId: RECORD_LESS,
      type: "sent", at: clock.now().toISOString(),
    });
  }
  stores.folds = 0;

  await checkDeliverability(stores, { publish: async () => {} } as never, clock, ORG, RECORD_LESS);

  assert.equal(stores.folds, 0, "the event log was folded despite stored counters existing");
});

test("an id with no stored counters still folds, so old ids keep working", async () => {
  // The fallback is correct, not a bug: ids whose events predate the SENDID#
  // index have no counter row, and evaluating them must still work.
  const stores = instrumented(); // no sendIdCounters
  const clock = new SystemClock();
  await stores.alerts.put(defaultAlertConfig(ORG));
  await stores.events.append({
    orgId: ORG, subscriberId: "s1", campaignId: RECORD_LESS,
    type: "bounce", at: clock.now().toISOString(),
  });
  stores.folds = 0;

  await checkDeliverability(stores, { publish: async () => {} } as never, clock, ORG, RECORD_LESS);

  assert.equal(stores.folds, 1, "an id with no counters must fall back to the event log");
});
