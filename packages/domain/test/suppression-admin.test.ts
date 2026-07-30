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

test("manualSuppress with no source stays manual + org-scoped, exactly as before #247", async () => {
  const { stores, clock } = await seed();
  const res = await manualSuppress(stores, clock, { orgId: ORG, email: "reader@example.com" });
  assert.equal(res.source, "manual");
  assert.equal(res.scope, "org");
  const [entry] = await stores.suppression.entriesFor(ORG, "reader@example.com");
  assert.equal(entry?.source, "manual");
  assert.equal(entry?.scope, "org");
});

test("manualSuppress with source bounce or complaint lands GLOBAL, matching the automatic path (#247)", async () => {
  for (const source of ["bounce", "complaint"] as const) {
    const { stores, clock } = await seed();
    const res = await manualSuppress(stores, clock, { orgId: ORG, email: "reader@example.com", source });
    assert.equal(res.source, source, source);
    // The whole point: an operator recording "customer support was told this
    // address bounces" gets the SAME protection scope an SES notification
    // saying the same thing would have produced — not a weaker, org-only one.
    assert.equal(res.scope, "global", source);
    const [entry] = await stores.suppression.entriesFor(ORG, "reader@example.com");
    assert.equal(entry?.scope, "global", source);

    // And it is invisible to the ORG-scoped list view, same as an automatic
    // bounce/complaint entry — global entries are reviewed elsewhere (#240's
    // import writes the same shape).
    assert.equal((await stores.suppression.list(ORG)).length, 0, source);
  }
});

test("liftSuppression never removes a manually-recorded bounce/complaint entry", async () => {
  // The same rule that already protected automatic global entries: `lift` is
  // scoped "org" only. A manual bounce/complaint entry landing "global" (above)
  // means an Editor/Support suppress-then-unsuppress cycle cannot erase it —
  // exactly the guarantee `subscriberUnsuppressHandler`'s #247 comment claims.
  const { stores, clock } = await seed();
  await manualSuppress(stores, clock, { orgId: ORG, email: "reader@example.com", source: "bounce" });
  await liftSuppression(stores, { orgId: ORG, email: "reader@example.com" });
  const [entry] = await stores.suppression.entriesFor(ORG, "reader@example.com");
  assert.equal(entry?.source, "bounce", "the global entry must survive an org-scoped lift");
});
