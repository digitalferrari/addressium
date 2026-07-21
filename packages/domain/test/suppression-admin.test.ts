/**
 * Admin suppression management (#102): org-scoped listing and lifting a
 * suppression reactivates the subscriber, while global entries are untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Subscriber } from "@addressium/core";
import { memStores, SystemClock, manualSuppress, liftSuppression } from "@addressium/domain";

const ORG = "summit";

async function seed() {
  const stores = memStores();
  const clock = new SystemClock();
  const sub: Subscriber = {
    orgId: ORG,
    sub: "s1",
    email: "reader@example.com",
    attributes: {},
    status: "active",
    entitlement: "free",
  };
  await stores.subscribers.put(sub);
  return { stores, clock };
}

test("suppression.list returns org-scoped entries; lift reactivates the subscriber", async () => {
  const { stores, clock } = await seed();

  await manualSuppress(stores, clock, { orgId: ORG, email: "reader@example.com" });
  // A global (cross-org) entry must not appear in the org list.
  await stores.suppression.add({
    orgId: ORG,
    email: "bounced@example.com",
    source: "bounce",
    scope: "global",
    addedAt: clock.now().toISOString(),
  });

  const list = await stores.suppression.list(ORG);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.email, "reader@example.com");
  assert.equal((await stores.subscribers.findByEmail(ORG, "reader@example.com"))?.status, "suppressed");

  const res = await liftSuppression(stores, { orgId: ORG, email: "reader@example.com" });
  assert.equal(res.subscriberReactivated, true);
  assert.equal((await stores.suppression.list(ORG)).length, 0);
  assert.equal((await stores.subscribers.findByEmail(ORG, "reader@example.com"))?.status, "active");
});
