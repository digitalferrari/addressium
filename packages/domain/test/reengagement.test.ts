/**
 * Engagement-based sunset + win-back automation (§4.19): coldness is judged from
 * click recency (opens ignored); cold subscribers are enrolled, advanced a step
 * at a time, graduate on a click, and are sunset (unsub-all + `inactive`
 * suppression) if they never engage. Decisions are unit-tested pure; the sweep
 * is driven end-to-end over a fake clock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { List, Organization, Subscriber, Subscription } from "@addressium/core";
import {
  DEFAULT_REENGAGEMENT_POLICY,
  coldnessAnchor,
  daysSince,
  decideReengagement,
  reengagementCampaignId,
  resolveReengagementPolicy,
  runReengagementSweep,
  memStores,
  CaptureSender,
  JoseMagicLinkSigner,
  type EmailTemplate,
} from "@addressium/domain";
import { generateKeyPair } from "jose";

const ORG = "summit";
const POLICY = resolveReengagementPolicy({ enabled: true }); // 180d cold, 3 steps, 7d apart
const NOW = new Date("2026-07-20T00:00:00Z");

class FakeClock {
  constructor(private t: Date) {}
  now() {
    return this.t;
  }
  advanceDays(n: number) {
    this.t = new Date(this.t.getTime() + n * 86_400_000);
  }
}

const sub = (over: Partial<Subscriber> = {}): Subscriber => ({
  orgId: ORG, sub: "s1", email: "s1@x.com", attributes: {}, status: "active", entitlement: "free", ...over,
});

// ---- pure helpers ----

test("daysSince floors elapsed days and never goes negative", () => {
  assert.equal(daysSince("2026-07-10T00:00:00Z", NOW), 10);
  assert.equal(daysSince("2026-07-19T18:00:00Z", NOW), 0); // 6h → 0 whole days
  assert.equal(daysSince("2026-08-01T00:00:00Z", NOW), 0); // future → clamped
});

test("coldnessAnchor prefers last click, falls back to consent, else undefined", () => {
  assert.equal(coldnessAnchor(sub({ lastEngagedAt: "2026-01-01T00:00:00Z" })), "2026-01-01T00:00:00Z");
  assert.equal(
    coldnessAnchor(sub({ consent: { timestamp: "2025-01-01T00:00:00Z", ip: "0.0.0.0", sourceUrl: "u" } })),
    "2025-01-01T00:00:00Z",
  );
  assert.equal(coldnessAnchor(sub()), undefined);
});

test("defaults are conservative and off by default", () => {
  assert.equal(DEFAULT_REENGAGEMENT_POLICY.enabled, false);
  assert.equal(DEFAULT_REENGAGEMENT_POLICY.coldAfterDays, 180);
  assert.equal(DEFAULT_REENGAGEMENT_POLICY.steps, 3);
});

// ---- decision state machine ----

const decide = (s: Subscriber, hasActiveSubscription = true, policy = POLICY, now = NOW) =>
  decideReengagement({ subscriber: s, hasActiveSubscription, policy, now });

test("disabled policy → skip", () => {
  const d = decide(sub({ lastEngagedAt: "2026-01-01T00:00:00Z" }), true, resolveReengagementPolicy({ enabled: false }));
  assert.deepEqual(d, { action: "skip", reason: "disabled" });
});

test("already-suppressed subscriber → skip", () => {
  assert.deepEqual(decide(sub({ status: "suppressed", lastEngagedAt: "2026-01-01T00:00:00Z" })), {
    action: "skip",
    reason: "suppressed",
  });
});

test("no active subscription → skip (don't enroll the already-gone)", () => {
  assert.deepEqual(decide(sub({ lastEngagedAt: "2026-01-01T00:00:00Z" }), false), {
    action: "skip",
    reason: "no active subscription",
  });
});

test("no engagement anchor → skip (never mailed, can't judge)", () => {
  assert.deepEqual(decide(sub()), { action: "skip", reason: "no engagement anchor" });
});

test("still warm → skip", () => {
  assert.deepEqual(decide(sub({ lastEngagedAt: "2026-07-01T00:00:00Z" })), { action: "skip", reason: "still warm" });
});

test("cold and not enrolled → send step 1 (enroll)", () => {
  assert.deepEqual(decide(sub({ lastEngagedAt: "2026-01-01T00:00:00Z" })), { action: "send", step: 1 });
});

test("enrolled but clicked since enrolling → graduate", () => {
  const s = sub({
    lastEngagedAt: "2026-07-19T00:00:00Z",
    reengagement: { enrolledAt: "2026-07-10T00:00:00Z", stepsSent: 1, lastStepAt: "2026-07-10T00:00:00Z" },
  });
  assert.deepEqual(decide(s), { action: "graduate" });
});

test("enrolled, spacing not elapsed → wait", () => {
  const s = sub({
    lastEngagedAt: "2026-01-01T00:00:00Z",
    reengagement: { enrolledAt: "2026-07-18T00:00:00Z", stepsSent: 1, lastStepAt: "2026-07-18T00:00:00Z" },
  });
  assert.deepEqual(decide(s), { action: "wait" });
});

test("enrolled, spacing elapsed, steps remain → send next step", () => {
  const s = sub({
    lastEngagedAt: "2026-01-01T00:00:00Z",
    reengagement: { enrolledAt: "2026-07-01T00:00:00Z", stepsSent: 1, lastStepAt: "2026-07-10T00:00:00Z" },
  });
  assert.deepEqual(decide(s), { action: "send", step: 2 });
});

test("enrolled, sequence exhausted, spacing elapsed → sunset", () => {
  const s = sub({
    lastEngagedAt: "2026-01-01T00:00:00Z",
    reengagement: { enrolledAt: "2026-06-01T00:00:00Z", stepsSent: 3, lastStepAt: "2026-07-10T00:00:00Z" },
  });
  assert.deepEqual(decide(s), { action: "sunset" });
});

// ---- end-to-end sweep ----

async function harness(
  policyOverride: { enabled?: boolean; coldAfterDays?: number; steps?: number; stepIntervalDays?: number } = {
    enabled: true,
    steps: 2,
  },
) {
  const stores = memStores();
  const sender = new CaptureSender();
  const clock = new FakeClock(new Date(NOW));
  const { privateKey } = await generateKeyPair("ES256");
  const magic = new JoseMagicLinkSigner({ privateKey, kid: "k", issuer: "i", audience: "a", ttlSeconds: 60 }, clock);

  const org: Organization = {
    orgId: ORG, name: "Summit", domains: ["x.com"], subscriberPoolId: "pool",
    magicLink: { kmsKeyArn: "arn", kid: "k", issuer: "i", audience: "a" },
    sesConfigSet: "cs", ipMode: "shared", suppressionScope: "org", defaultTimezone: "UTC",
    reengagement: { enabled: true, coldAfterDays: 180, steps: 2, stepIntervalDays: 7, ...policyOverride },
    setupComplete: true,
  };
  await stores.organizations.put(org);

  const list: List = {
    orgId: ORG, listId: "ledger", name: "Ledger", optInPolicy: "double",
    fromAddress: "l@northwindtimes.example", access: "free", visibility: "open",
    complianceFooter: "f", physicalAddress: "a",
  };
  await stores.lists.put(list);

  const put = async (s: Subscriber, subscribed = true) => {
    await stores.subscribers.put(s);
    if (subscribed) {
      const sn: Subscription = { orgId: ORG, subscriberId: s.sub, listId: "ledger", status: "confirmed", updatedAt: "t" };
      await stores.subscriptions.put(sn);
    }
  };
  const template: EmailTemplate = { blocks: [{ kind: "text", html: "we miss you" }] };
  const sweep = () =>
    runReengagementSweep(stores, sender, magic, clock, { orgId: ORG, listId: "ledger", subject: "Still there?", template });

  return { stores, sender, clock, put, sweep };
}

test("cold subscriber runs the full lifecycle to sunset", async () => {
  const { stores, sender, clock, put, sweep } = await harness();
  await put(sub({ sub: "cold", email: "cold@x.com", lastEngagedAt: "2026-01-01T00:00:00Z" }));
  await put(sub({ sub: "warm", email: "warm@x.com", lastEngagedAt: "2026-07-15T00:00:00Z" })); // untouched

  // Pass 1: enroll cold, send step 1.
  let r = await sweep();
  assert.equal(r.enrolled, 1);
  assert.equal(r.stepped, 0);
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0]?.to, "cold@x.com");
  assert.equal((await stores.subscribers.get(ORG, "cold"))?.reengagement?.stepsSent, 1);

  // Same-day re-run is a no-op (spacing gate).
  r = await sweep();
  assert.deepEqual([r.enrolled, r.stepped, r.sunset], [0, 0, 0]);
  assert.equal(sender.sent.length, 1);

  // Pass 2 (8 days later): send step 2.
  clock.advanceDays(8);
  r = await sweep();
  assert.equal(r.stepped, 1);
  assert.equal(sender.sent.length, 2);
  assert.equal((await stores.subscribers.get(ORG, "cold"))?.reengagement?.stepsSent, 2);

  // Pass 3 (8 more days): sequence exhausted → sunset.
  clock.advanceDays(8);
  r = await sweep();
  assert.equal(r.sunset, 1);
  const gone = await stores.subscribers.get(ORG, "cold");
  assert.equal(gone?.status, "suppressed");
  assert.equal(gone?.reengagement, undefined);
  assert.equal(await stores.suppression.isSuppressed(ORG, "cold@x.com"), true);
  const entries = await stores.suppression.entriesFor(ORG, "cold@x.com");
  assert.equal(entries[0]?.source, "inactive");
  assert.equal((await stores.subscriptions.get(ORG, "cold", "ledger"))?.status, "unsubscribed");

  // The warm subscriber was never enrolled or mailed.
  assert.equal((await stores.subscribers.get(ORG, "warm"))?.reengagement, undefined);
  assert.equal(sender.sent.some((m) => m.to === "warm@x.com"), false);
});

test("a click during the sequence graduates instead of sunsetting", async () => {
  const { stores, clock, put, sweep } = await harness();
  await put(sub({ sub: "back", email: "back@x.com", lastEngagedAt: "2026-01-01T00:00:00Z" }));

  await sweep(); // enroll (step 1)
  assert.equal((await stores.subscribers.get(ORG, "back"))?.reengagement?.stepsSent, 1);

  // They click a link in the win-back email a few days later.
  clock.advanceDays(3);
  await stores.subscribers.markEngaged(ORG, "back", "2026-07-23T00:00:00Z");

  clock.advanceDays(5); // spacing elapsed, but the click wins
  const r = await sweep();
  assert.equal(r.graduated, 1);
  assert.equal(r.sunset, 0);
  const s = await stores.subscribers.get(ORG, "back");
  assert.equal(s?.reengagement, undefined);
  assert.equal(s?.status, "active");
  assert.equal(await stores.suppression.isSuppressed(ORG, "back@x.com"), false);
});

test("a re-opt-in can self-clear an inactive sunset suppression", async () => {
  const { stores, clock, put, sweep } = await harness({ enabled: true, steps: 1 });
  await put(sub({ sub: "gone", email: "gone@x.com", lastEngagedAt: "2026-01-01T00:00:00Z" }));

  await sweep(); // step 1 (enroll)
  clock.advanceDays(8);
  await sweep(); // steps==1 exhausted → sunset
  assert.equal(await stores.suppression.isSuppressed(ORG, "gone@x.com"), true);

  // The signup path's re-opt-in policy treats an org-scoped "inactive" entry as
  // self-clearable — same rule as a prior unsubscribe.
  const entries = await stores.suppression.entriesFor(ORG, "gone@x.com");
  assert.equal(entries.every((e) => e.source === "inactive" && e.scope === "org"), true);
});

test("reengagementCampaignId is per-step so engagement aggregates apart", () => {
  assert.equal(reengagementCampaignId("ledger", 1), "reengagement:ledger#1");
  assert.notEqual(reengagementCampaignId("ledger", 1), reengagementCampaignId("ledger", 2));
});
