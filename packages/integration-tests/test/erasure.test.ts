/**
 * GDPR erasure actually erasing (#164).
 *
 * `eraseSubscriber` anonymized exactly ONE DynamoDB item and returned `true`. An
 * operator ran the endpoint, got a success, and reported compliance — while the
 * `externalId → sub` pointer still resolved the person from their Cognito sub,
 * the email-reservation item still held their plaintext address in its sort key,
 * the entitlement record still linked them to a billing system, and every
 * engagement event still bore their subscriber id.
 *
 * Each test below names the specific survivor it kills. The two things that are
 * deliberately KEPT — the suppression tombstone and the consent timestamps — get
 * tests of their own, because a fix that removed those would be a different bug:
 * silently re-mailable subjects, and an org with no evidence it was ever
 * entitled to mail them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  eraseSubscriber,
  erasureFromImage,
  exportSubscriber,
  memStores,
  signup,
  toErasureAnalyticsRow,
  LAKE_RETENTION_DAYS,
  type Clock,
  type Stores,
} from "@addressium/domain";
import type { List, Subscriber, Subscription } from "@addressium/core";

const ORG = "summit";
const LIST = "ledger";
const EMAIL = "reader@x.com";
const EXTERNAL_ID = "cognito-sub-9f3a";
const clock: Clock = { now: () => new Date("2026-07-29T12:00:00.000Z") };

const list = (listId: string): List => ({
  orgId: ORG, listId, name: listId, optInPolicy: "double", fromAddress: "l@x.com",
  access: "free", visibility: "open", complianceFooter: "f", physicalAddress: "1 Main St",
});

/** A subject with every kind of trace the system can leave behind. */
async function seed(): Promise<Stores> {
  const stores = memStores();
  await stores.lists.put(list(LIST));
  await stores.lists.put(list("weekly"));

  const subscriber: Subscriber = {
    orgId: ORG, sub: "s1", email: EMAIL, externalId: EXTERNAL_ID,
    attributes: { first_name: "Ada", city: "Denver" },
    status: "active", entitlement: "paid",
    consent: { timestamp: "2026-01-01T00:00:00.000Z", ip: "203.0.113.9", sourceUrl: "https://x.com/signup" },
  };
  await stores.subscribers.put(subscriber);
  await stores.subscribers.reserveEmail(ORG, EMAIL, "s1");

  for (const listId of [LIST, "weekly"]) {
    const s: Subscription = {
      orgId: ORG, subscriberId: "s1", listId, status: "confirmed", updatedAt: "",
      consent: {
        requestedAt: "2026-01-01T00:00:00.000Z", confirmedAt: "2026-01-01T00:05:00.000Z",
        basis: "explicit", requestIp: "203.0.113.9", userAgent: "Mozilla/5.0",
        sourceUrl: "https://x.com/signup",
      },
    };
    await stores.subscriptions.put(s);
  }

  await stores.entitlements.put({
    orgId: ORG, subscriberId: "s1", source: "stripe", value: "paid",
    version: "1", at: "2026-01-02T00:00:00.000Z",
  });

  // Events across TWO campaigns, plus another subscriber's, which must survive.
  for (const campaignId of ["c1", "c2"]) {
    await stores.campaigns.put({
      orgId: ORG, campaignId, type: "one_off", subject: "s", templateId: "t",
      audience: { listId: LIST }, status: "sent",
      counters: { sent: 2, delivered: 2, opens: 1, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 },
    });
    await stores.events.append({
      orgId: ORG, campaignId, subscriberId: "s1", type: "sent", at: "2026-02-01T00:00:00.000Z",
    });
    await stores.events.append({
      orgId: ORG, campaignId, subscriberId: "other", type: "sent", at: "2026-02-01T00:00:00.000Z",
    });
  }
  return stores;
}

// ---- the survivors #164 names ----

test("the Cognito sub no longer resolves the erased person", async () => {
  // The single most durable identifier in the system. The old erase projection
  // spread `...subscriber` and simply never mentioned `externalId`, and the
  // pointer item it resolves through was never touched at all.
  const stores = await seed();
  assert.ok(await stores.subscribers.findByExternalId(ORG, EXTERNAL_ID), "resolvable before");

  const report = await eraseSubscriber(stores, clock, ORG, EMAIL);
  assert.equal(report.externalIdRemoved, true);
  assert.equal(await stores.subscribers.findByExternalId(ORG, EXTERNAL_ID), undefined);
  assert.equal((await stores.subscribers.get(ORG, "s1"))?.externalId, undefined);
});

test("the email reservation no longer holds the plaintext address", async () => {
  // The reservation item's SORT KEY is the address, so leaving it behind leaves
  // the erased person's email in the table under a different item. Observable
  // here as: the address can be claimed again.
  const stores = await seed();
  const report = await eraseSubscriber(stores, clock, ORG, EMAIL);
  assert.equal(report.emailReservationReleased, true);
  const { sub } = await stores.subscribers.reserveEmail(ORG, EMAIL, "brand-new");
  assert.equal(sub, "brand-new", "a later signup must not be handed the erased id");
});

test("the entitlement record — subject to billing system — is gone", async () => {
  const stores = await seed();
  assert.ok(await stores.entitlements.latest(ORG, "s1"), "present before");
  const report = await eraseSubscriber(stores, clock, ORG, EMAIL);
  assert.equal(report.entitlementRemoved, true);
  assert.equal(await stores.entitlements.latest(ORG, "s1"), undefined);
});

test("engagement events across every campaign are deleted — and only theirs", async () => {
  const stores = await seed();
  const report = await eraseSubscriber(stores, clock, ORG, EMAIL);
  assert.equal(report.eventsDeleted, 2, "one per campaign");
  for (const campaignId of ["c1", "c2"]) {
    const rows = await stores.events.all(ORG, campaignId);
    assert.deepEqual(rows.map((e) => e.subscriberId), ["other"], `${campaignId}: only theirs`);
  }
});

test("campaign counters are NOT rewritten", async () => {
  // Aggregates, not personal data. Decrementing them would edit historical
  // reports to hide that a send happened, which is not what erasure asks for —
  // and would make every report irreproducible after any erasure.
  const stores = await seed();
  const before = (await stores.campaigns.get(ORG, "c1"))?.counters;
  await eraseSubscriber(stores, clock, ORG, EMAIL);
  assert.deepEqual((await stores.campaigns.get(ORG, "c1"))?.counters, before);
});

test("the profile carries no PII afterwards", async () => {
  const stores = await seed();
  await eraseSubscriber(stores, clock, ORG, EMAIL);
  const after = (await stores.subscribers.get(ORG, "s1"))!;
  assert.equal(after.email, "erased:s1");
  assert.deepEqual(after.attributes, {});
  assert.equal(after.consent, undefined, "signup IP and source URL are personal data");
  assert.equal(after.status, "suppressed");
  assert.equal(after.entitlement, "free");
  // And they are no longer findable by the address they gave.
  assert.equal(await stores.subscribers.findByEmail(ORG, EMAIL), undefined);
  assert.equal(await exportSubscriber(stores, ORG, EMAIL), undefined);
});

test("identifying consent fields go; the evidence of consent stays", async () => {
  // Both halves matter. The IP, user agent and source URL are personal data. The
  // timestamps and basis are the org's evidence it was once entitled to mail the
  // address — which an erasure request does not retroactively undo.
  const stores = await seed();
  await eraseSubscriber(stores, clock, ORG, EMAIL);
  for (const s of await stores.subscriptions.listBySubscriber(ORG, "s1")) {
    assert.equal(s.status, "unsubscribed");
    assert.equal(s.consent?.requestIp, undefined);
    assert.equal(s.consent?.userAgent, undefined);
    assert.equal(s.consent?.sourceUrl, undefined);
    assert.equal(s.consent?.basis, "explicit");
    assert.equal(s.consent?.confirmedAt, "2026-01-01T00:05:00.000Z");
  }
});

test("the suppression tombstone keeps the address, and blocks a re-add", async () => {
  // Deliberate: retaining an address specifically to honour an opt-out is a
  // recognised lawful basis, and without it the next CSV import silently
  // re-adds the person who asked to be forgotten.
  const stores = await seed();
  await eraseSubscriber(stores, clock, ORG, EMAIL);
  assert.equal(await stores.suppression.isSuppressed(ORG, EMAIL), true);
  await assert.rejects(
    () =>
      signup(
        stores,
        // Never reached: signup rejects on the suppression tombstone first.
        { sign: () => "tok", verify: () => ({ orgId: ORG, sub: "x", exp: 0 }) },
        clock,
        { orgId: ORG, email: EMAIL, listId: LIST },
        {},
      ),
    "an erased subject must not be re-addable by signing up again",
  );
});

// ---- the report ----

test("the report says what was reached, not just `true`", async () => {
  // "erased: true" is what made this defect invisible — it said the same thing
  // whether one item was anonymized or every trace was removed.
  const stores = await seed();
  const report = await eraseSubscriber(stores, clock, ORG, EMAIL);
  assert.deepEqual(report, {
    found: true,
    subscriberId: "s1",
    subscriptionsRedacted: 2,
    eventsDeleted: 2,
    externalIdRemoved: true,
    entitlementRemoved: true,
    emailReservationReleased: true,
  });
});

test("an unknown address reports not-found rather than throwing", async () => {
  const stores = await seed();
  const report = await eraseSubscriber(stores, clock, ORG, "nobody@x.com");
  assert.equal(report.found, false);
  assert.equal(report.eventsDeleted, 0);
});

test("a subject with no externalId does not claim one was removed", async () => {
  const stores = memStores();
  await stores.subscribers.put({
    orgId: ORG, sub: "s2", email: "plain@x.com", attributes: {}, status: "active", entitlement: "free",
  });
  const report = await eraseSubscriber(stores, clock, ORG, "plain@x.com");
  assert.equal(report.found, true);
  assert.equal(report.externalIdRemoved, false);
});

// ---- the lake ----

test("an erasure writes the tombstone the lake anti-joins on", async () => {
  const stores = await seed();
  await eraseSubscriber(stores, clock, ORG, EMAIL);
  const tombstone = await stores.erasures.get(ORG, "s1");
  assert.equal(tombstone?.subscriberId, "s1");
  assert.equal(tombstone?.erasedAt, "2026-07-29T12:00:00.000Z");
  // It carries no personal data: a random id whose link to a person was
  // destroyed by the same erasure that wrote it.
  assert.deepEqual(Object.keys(tombstone!).sort(), ["erasedAt", "orgId", "subscriberId"]);
});

test("the tombstone reaches the fact tier as an `erased` row", async () => {
  // Rows already written to S3 cannot be deleted per subject — compressed,
  // partitioned, append-only objects — so every query anti-joins against these.
  // Landing them in the SAME table means no second Firehose and no partition an
  // operator's query can forget.
  const image = {
    sk: { S: "ERASURE#s1" },
    data: {
      M: {
        orgId: { S: ORG },
        subscriberId: { S: "s1" },
        erasedAt: { S: "2026-07-29T12:00:00.000Z" },
      },
    },
  };
  const parsed = erasureFromImage(image);
  assert.ok(parsed);
  const row = toErasureAnalyticsRow(parsed);
  assert.equal(row.event_type, "erased");
  assert.equal(row.subscriber_id, "s1");
  assert.equal(row.org_id, ORG);
  // Partitioned by the day of erasure, like every other row in the table.
  assert.equal(row.event_date, "2026-07-29");
  assert.equal(row.link_id, null);
});

test("a non-erasure item is not mistaken for a tombstone", async () => {
  assert.equal(erasureFromImage({ sk: { S: "EVENT#abc" } }), null);
  assert.equal(erasureFromImage({ sk: { S: "SUBSCRIBER#s1" } }), null);
  assert.equal(erasureFromImage(undefined), null);
  // An incomplete tombstone is dropped rather than half-projected — a row with
  // an empty subscriber_id would anti-join away every row in the partition.
  assert.equal(erasureFromImage({ sk: { S: "ERASURE#s1" }, data: { M: { orgId: { S: ORG } } } }), null);
});

test("the retention window is only quoted when a lake exists", async () => {
  // Claiming one on a deployment with analytics off would be a number the
  // operator cannot check against any bucket.
  const stores = await seed();
  const off = await eraseSubscriber(stores, clock, ORG, EMAIL);
  assert.equal(off.lakeRowsExpireBy, undefined);

  const stores2 = await seed();
  const on = await eraseSubscriber(stores2, clock, ORG, EMAIL, { analyticsEnabled: true });
  assert.ok(on.lakeRowsExpireBy, "an operator must be told the window, not left to guess");
  const days = (Date.parse(on.lakeRowsExpireBy!) - clock.now().getTime()) / 86_400_000;
  assert.equal(days, LAKE_RETENTION_DAYS);
});

test("a shorter configured window is what gets reported", async () => {
  // The CDK reads the same number for the bucket's lifecycle rule, so what the
  // subject is told matches what actually expires the rows.
  const stores = await seed();
  const report = await eraseSubscriber(stores, clock, ORG, EMAIL, {
    analyticsEnabled: true,
    lakeRetentionDays: 30,
  });
  const days = (Date.parse(report.lakeRowsExpireBy!) - clock.now().getTime()) / 86_400_000;
  assert.equal(days, 30);
});
