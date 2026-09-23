/**
 * The re-engagement sweep must not read subscriptions for everyone (#293 item 2).
 *
 * `sweepOne` called `subscriptions.listBySubscriber` unconditionally — a full
 * `gsi2` query per subscriber on Dynamo — to compute `hasActiveSubscription`.
 * But `decideReengagement` consults that value on exactly ONE branch: the
 * not-yet-enrolled path, and only after suppression, the engagement anchor and
 * the coldness threshold have all passed. For every other subscriber the read
 * was paid for and discarded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  memStores,
  runReengagementSweep,
  decideReengagement,
  needsSubscriptionLookup,
  DEFAULT_REENGAGEMENT_POLICY,
} from "@addressium/domain";
import type { Stores } from "@addressium/domain";
import type { Subscriber } from "@addressium/core";

const ORG = "acme";
const LIST = "ledger";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const COLD = "2025-06-01T00:00:00.000Z";  // >180d before NOW: past coldAfterDays
const WARM = "2026-06-28T00:00:00.000Z";  // engaged days ago

const clock = { now: () => NOW };

/** memStores with a counting `subscriptions.listBySubscriber`. */
function instrumented() {
  const stores = memStores() as Stores & { lookups: number };
  stores.lookups = 0;
  const real = stores.subscriptions.listBySubscriber.bind(stores.subscriptions);
  stores.subscriptions.listBySubscriber = async (o: string, s: string) => {
    stores.lookups++;
    return real(o, s);
  };
  return stores;
}

async function seed(stores: Stores, n: number, shape: (i: number) => Partial<Subscriber>) {
  await stores.lists.put({
    orgId: ORG, listId: LIST, name: "Ledger", optInPolicy: "double",
    fromAddress: "news@acme.example", access: "free", visibility: "open",
    complianceFooter: "footer", physicalAddress: "1 Main St",
  });
  await stores.organizations.put({
    orgId: ORG, name: "Acme", environment: "dev",
    reengagement: { enabled: true, listId: LIST },
  } as never);
  for (let i = 0; i < n; i++) {
    const sub = `s${String(i).padStart(4, "0")}`;
    await stores.subscribers.put({
      orgId: ORG, sub, email: `r${i}@x.example`, status: "active",
      entitlement: "free", attributes: {}, ...shape(i),
    } as Subscriber);
    await stores.subscriptions.put({
      orgId: ORG, subscriberId: sub, listId: LIST, status: "confirmed",
      updatedAt: NOW.toISOString(),
    });
  }
}

test("the sweep reads subscriptions only for cold, unenrolled subscribers", async () => {
  const stores = instrumented();
  // 100 subscribers: 10 cold and unenrolled (the only ones whose decision can
  // turn on the flag), 80 still warm, 10 already enrolled.
  await seed(stores, 100, (i) => {
    if (i < 10) return { lastEngagedAt: COLD };
    if (i < 90) return { lastEngagedAt: WARM };
    return { lastEngagedAt: COLD, reengagement: { enrolledAt: COLD, stepsSent: 1, lastStepAt: COLD } };
  });
  stores.lookups = 0;

  await runReengagementSweep(
    stores,
    { send: async () => {} } as never,
    undefined as never,
    clock as never,
    { orgId: ORG, listId: LIST, subject: "Come back", template: { blocks: [] } } as never,
  );

  // 10, not 100. The unconditional version read every subscriber.
  assert.equal(stores.lookups, 10, `expected 10 lookups, got ${stores.lookups}`);
});

/**
 * The predicate and the decision must agree.
 *
 * When `needsSubscriptionLookup` is false the sweep passes `false` without
 * reading anything — which is only safe if the decision is genuinely identical
 * either way. A comment asserting that would rot; this does not.
 */
test("when no lookup is needed, the decision ignores the flag entirely", () => {
  // The default is enabled:false — the sweep is opt-in — so enable it here.
  const policy = { ...DEFAULT_REENGAGEMENT_POLICY, enabled: true };
  const base = { orgId: ORG, sub: "s1", email: "r@x.example", entitlement: "free", attributes: {} };
  const cases: Subscriber[] = [
    { ...base, status: "active", lastEngagedAt: WARM } as Subscriber,            // still warm
    { ...base, status: "suppressed", lastEngagedAt: COLD } as Subscriber,        // suppressed
    { ...base, status: "active" } as Subscriber,                                 // no anchor
    { ...base, status: "active", lastEngagedAt: COLD,                            // already enrolled
      reengagement: { enrolledAt: COLD, stepsSent: 1, lastStepAt: COLD } } as Subscriber,
  ];

  for (const subscriber of cases) {
    assert.equal(
      needsSubscriptionLookup(subscriber, policy, NOW), false,
      `this fixture should not need a lookup: ${JSON.stringify(subscriber)}`,
    );
    const withTrue = decideReengagement({ subscriber, hasActiveSubscription: true, policy, now: NOW });
    const withFalse = decideReengagement({ subscriber, hasActiveSubscription: false, policy, now: NOW });
    // ACTION, not the whole object. `hasActiveSubscription` is checked before
    // the anchor and coldness branches, so a warm subscriber passed `false`
    // reports reason "no active subscription" rather than "still warm". Both are
    // `skip`, and `sweepOne` switches on the action alone — the reason is
    // diagnostic. What must never differ is what the sweep DOES.
    assert.equal(
      withTrue.action, withFalse.action,
      `the sweep's action DOES depend on the flag, so skipping the lookup is unsafe: ${JSON.stringify(subscriber)}`,
    );
  }
});

test("a cold unenrolled subscriber DOES need the lookup", () => {
  // The negative case. If the predicate were simply `false` the first test would
  // pass with zero lookups and re-engagement would silently enroll people who
  // had already unsubscribed from everything.
  // The default is enabled:false — the sweep is opt-in — so enable it here.
  const policy = { ...DEFAULT_REENGAGEMENT_POLICY, enabled: true };
  const subscriber = {
    orgId: ORG, sub: "s1", email: "r@x.example", status: "active",
    entitlement: "free", attributes: {}, lastEngagedAt: COLD,
  } as Subscriber;

  assert.equal(needsSubscriptionLookup(subscriber, policy, NOW), true);
  assert.notDeepEqual(
    decideReengagement({ subscriber, hasActiveSubscription: true, policy, now: NOW }),
    decideReengagement({ subscriber, hasActiveSubscription: false, policy, now: NOW }),
    "this is exactly the case the lookup exists for",
  );
});
