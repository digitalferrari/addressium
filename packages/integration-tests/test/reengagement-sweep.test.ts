/**
 * The re-engagement sweep, wired and resumable (#233, #182 item 4).
 *
 * `reengagementSweepHandler` existed, was exported, and NO CDK construct
 * referenced it — the whole sunset automation was domain logic with no caller,
 * and the 21 unit tests covering it passed throughout because they exercise the
 * domain function directly.
 *
 * Two things had to be decided before it could be wired, and both are asserted
 * here rather than left to a comment. The sweep's terminal step UNSUBSCRIBES
 * cold subscribers, so it is **per-org opt-in**: a deployment-wide default would
 * start silently shrinking lists on installs where nobody asked. And it walks an
 * entire org, so it **checkpoints**: without one a retry restarted from zero and
 * an org large enough to matter was never fully swept — it burned the same first
 * N subscribers on every attempt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  memStores,
  runReengagementSweep,
  SystemClock,
  type Clock,
  type EmailSender,
  type Stores,
} from "@addressium/domain";
import type { List, Organization, Subscriber, Subscription } from "@addressium/core";

const ORG = "summit";
const LIST = "ledger";
/** Long after every subscriber below went cold. */
const clock: Clock = { now: () => new Date("2027-01-01T00:00:00.000Z") };
void SystemClock;

function silentSender(): EmailSender & { to: string[] } {
  const to: string[] = [];
  return { to, async send(msg) { to.push(msg.to); } };
}

const org = (over: Partial<Organization> = {}): Organization => ({
  orgId: ORG,
  name: "Summit",
  domains: ["x.com"],
  sesConfigSet: "cs",
  ipMode: "shared",
  suppressionScope: "org",
  defaultTimezone: "UTC",
  setupComplete: true,
  ...over,
});

async function seed(count: number, orgOver: Partial<Organization> = {}): Promise<Stores> {
  const stores = memStores();
  await stores.organizations.put(org(orgOver));
  const list: List = {
    orgId: ORG, listId: LIST, name: "Ledger", optInPolicy: "double",
    fromAddress: "l@x.com", access: "free", visibility: "open",
    complianceFooter: "f", physicalAddress: "1 Main St",
  };
  await stores.lists.put(list);
  for (let i = 0; i < count; i++) {
    const sub: Subscriber = {
      orgId: ORG,
      sub: `s${String(i).padStart(4, "0")}`,
      email: `s${i}@x.com`,
      attributes: {},
      status: "active",
      entitlement: "free",
      // Cold: last engaged well over the 180-day default.
      lastEngagedAt: "2026-01-01T00:00:00.000Z",
    };
    await stores.subscribers.put(sub);
    const s: Subscription = {
      orgId: ORG, subscriberId: sub.sub, listId: LIST, status: "confirmed", updatedAt: "",
    };
    await stores.subscriptions.put(s);
  }
  return stores;
}

const sweep = (stores: Stores, sender: EmailSender, over: Record<string, unknown> = {}) =>
  runReengagementSweep(stores, sender, undefined, clock, {
    orgId: ORG,
    listId: LIST,
    subject: "Still want these?",
    template: { blocks: [{ kind: "text", html: "<p>hi</p>" }] },
    ...over,
  });

// ---- opt-in ----

test("an org that never opted in is not swept at all", async () => {
  // The decision behind wiring this: the terminal step unsubscribes cold
  // subscribers, so a deployment-wide default would start shrinking lists on
  // installs where nobody asked for it — and a shrunk list cannot be undone.
  const stores = await seed(5);
  const sender = silentSender();
  const result = await sweep(stores, sender);
  assert.equal(result.scanned, 0, "not even scanned");
  assert.deepEqual(sender.to, []);
});

test("an org that opted in is swept", async () => {
  const stores = await seed(5, {
    reengagement: { enabled: true, coldAfterDays: 180, steps: 3, stepIntervalDays: 7, listId: LIST },
  });
  const sender = silentSender();
  const result = await sweep(stores, sender);
  assert.equal(result.scanned, 5);
  assert.equal(result.enrolled, 5, "all five are cold enough to enrol");
  assert.equal(sender.to.length, 5);
});

// ---- checkpointing ----

test("a bounded invocation hands back a cursor instead of running to the end", async () => {
  // Without this the sweep read the WHOLE org into memory and had no way to
  // record progress, so a timeout or a retry restarted from zero.
  const stores = await seed(25, {
    reengagement: { enabled: true, coldAfterDays: 180, steps: 3, stepIntervalDays: 7, listId: LIST },
  });
  const sender = silentSender();
  const first = await sweep(stores, sender, { maxSubscribers: 10 });
  assert.equal(first.scanned, 10);
  assert.ok(first.cursor, "not finished, so it must say where to resume");
});

test("resuming continues rather than repeating", async () => {
  // The exact failure: a retry that restarts from zero burns the same first N
  // subscribers forever and never reaches the tail.
  const stores = await seed(25, {
    reengagement: { enabled: true, coldAfterDays: 180, steps: 3, stepIntervalDays: 7, listId: LIST },
  });
  const sender = silentSender();

  let cursor: string | undefined;
  let scanned = 0;
  let passes = 0;
  do {
    const r = await sweep(stores, sender, { maxSubscribers: 10, ...(cursor ? { cursor } : {}) });
    scanned += r.scanned;
    cursor = r.cursor;
    passes++;
    assert.ok(passes < 10, "the sweep is not converging");
  } while (cursor);

  assert.equal(passes, 3, "25 subscribers at 10 per invocation");
  assert.equal(scanned, 25);
  // Every subscriber reached exactly once — the property a restart-from-zero
  // sweep cannot provide.
  assert.equal(sender.to.length, 25);
  assert.equal(new Set(sender.to).size, 25);
});

test("the final invocation returns NO cursor, which is how completion is known", async () => {
  const stores = await seed(8, {
    reengagement: { enabled: true, coldAfterDays: 180, steps: 3, stepIntervalDays: 7, listId: LIST },
  });
  const result = await sweep(stores, silentSender(), { maxSubscribers: 100 });
  assert.equal(result.cursor, undefined);
  assert.equal(result.scanned, 8);
});

test("a small org still finishes in ONE invocation", async () => {
  // Paging must not mean "one page per weekly firing" — that would take a small
  // org months to sweep once.
  const stores = await seed(150, {
    reengagement: { enabled: true, coldAfterDays: 180, steps: 3, stepIntervalDays: 7, listId: LIST },
  });
  const result = await sweep(stores, silentSender());
  assert.equal(result.cursor, undefined, "default budget covers a small org");
  assert.equal(result.scanned, 150);
});

// ---- what it does to people ----

test("a subscriber who is not cold is left alone", async () => {
  const stores = await seed(3, {
    reengagement: { enabled: true, coldAfterDays: 180, steps: 3, stepIntervalDays: 7, listId: LIST },
  });
  await stores.subscribers.put({
    orgId: ORG, sub: "s0000", email: "s0@x.com", attributes: {}, status: "active",
    entitlement: "free", lastEngagedAt: "2026-12-31T00:00:00.000Z",
  });
  const sender = silentSender();
  const result = await sweep(stores, sender);
  assert.equal(result.enrolled, 2, "the recently-engaged one is not enrolled");
  assert.ok(!sender.to.includes("s0@x.com"));
});

test("a subscriber with no engagement anchor at all is never sunset", async () => {
  // No click and no consent timestamp means no basis to judge. Sunsetting on
  // absence of evidence would unsubscribe people we simply never mailed.
  const stores = memStores();
  await stores.organizations.put(
    org({ reengagement: { enabled: true, coldAfterDays: 180, steps: 3, stepIntervalDays: 7, listId: LIST } }),
  );
  await stores.lists.put({
    orgId: ORG, listId: LIST, name: "Ledger", optInPolicy: "double", fromAddress: "l@x.com",
    access: "free", visibility: "open", complianceFooter: "f", physicalAddress: "1 Main St",
  });
  await stores.subscribers.put({
    orgId: ORG, sub: "s1", email: "unknown@x.com", attributes: {}, status: "active", entitlement: "free",
  });
  const sender = silentSender();
  const result = await sweep(stores, sender);
  assert.equal(result.scanned, 1);
  assert.equal(result.enrolled, 0);
  assert.equal(result.sunset, 0);
  assert.deepEqual(sender.to, []);
});
