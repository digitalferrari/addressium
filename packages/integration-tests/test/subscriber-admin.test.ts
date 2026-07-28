/**
 * Admin subscriber editing (#205).
 *
 * The Subscribers screen was read-plus-destructive-only. Attributes — the
 * merge-tag values every personalised send renders from — were invisible and
 * uneditable, and the only opt-in control was "unsubscribe from everything". So
 * test setup and support both required direct DynamoDB access.
 *
 * The tests that matter here are the ones about the two rules that make this
 * safe rather than convenient: manual confirmation is never a side effect and
 * never masquerades as a real opt-in, and suppression outranks every opt-in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  memStores,
  saveSegment,
  sendCampaign,
  setSubscriberAttributes,
  setSubscriptionStatus,
  subscriberDetail,
  SystemClock,
  type EmailSender,
  type SendDescriptor,
} from "@addressium/domain";
import { GsiSegmentEngine } from "@addressium/segment";
import type { List, Subscriber, Subscription } from "@addressium/core";

const ORG = "summit";
const clock = new SystemClock();

function recordingSender(): EmailSender & { sent: { to: string; html: string }[] } {
  const sent: { to: string; html: string }[] = [];
  return {
    sent,
    async send(msg) {
      sent.push({ to: msg.to, html: msg.html ?? "" });
    },
  };
}

const list = (listId: string, name: string): List => ({
  orgId: ORG, listId, name, optInPolicy: "double", fromAddress: "l@x.com",
  access: "free", visibility: "open", complianceFooter: "f", physicalAddress: "1 Main St",
});

async function seed() {
  const stores = memStores();
  await stores.lists.put(list("ledger", "The Ledger"));
  await stores.lists.put(list("weekly", "The Weekly"));
  const sub: Subscriber = {
    orgId: ORG, sub: "s1", email: "reader@x.com",
    attributes: { first_name: "Ada" }, status: "active", entitlement: "free",
  };
  await stores.subscribers.put(sub);
  const s: Subscription = {
    orgId: ORG, subscriberId: "s1", listId: "ledger", status: "confirmed", updatedAt: "",
    consent: { requestedAt: "2026-01-01T00:00:00.000Z", confirmedAt: "2026-01-01T00:05:00.000Z", basis: "explicit" },
  };
  await stores.subscriptions.put(s);
  return stores;
}

// ---- the detail view ----

test("the detail shows every list, including ones with no subscription", async () => {
  // "Not subscribed" is the state an operator most often wants to change, and a
  // list that does not appear cannot be opted into.
  const stores = await seed();
  const d = await subscriberDetail(stores, ORG, "s1");
  assert.deepEqual(d.lists.map((l) => l.listId).sort(), ["ledger", "weekly"]);
  assert.equal(d.lists.find((l) => l.listId === "ledger")?.status, "confirmed");
  assert.equal(d.lists.find((l) => l.listId === "weekly")?.status, undefined);
  assert.deepEqual(d.attributes, { first_name: "Ada" });
});

test("the detail names the explicit cohorts this subscriber is in", async () => {
  const stores = await seed();
  await saveSegment(stores, {
    orgId: ORG, segmentId: "cohort", name: "Test cohort",
    predicate: { match: "explicit", subscriberIds: ["s1"] },
  });
  await saveSegment(stores, {
    orgId: ORG, segmentId: "other", name: "Other", predicate: { match: "explicit", subscriberIds: ["s9"] },
  });
  // A rule-based segment is deliberately not evaluated here — the answer moves
  // without anyone editing anything, and it would cost one predicate run per
  // segment per detail view.
  await saveSegment(stores, {
    orgId: ORG, segmentId: "rule", name: "Rule",
    predicate: { match: "all", conditions: [{ field: "list", op: "in", value: "ledger" }] },
  });
  const d = await subscriberDetail(stores, ORG, "s1");
  assert.deepEqual(d.segments.map((s) => s.segmentId), ["cohort"]);
});

// ---- attributes ----

test("editing attributes changes what the next send renders", async () => {
  // The acceptance criterion. Attributes only matter because merge tags read
  // them, so the assertion is on the rendered body, not the stored map.
  const stores = await seed();
  await setSubscriberAttributes(stores, {
    orgId: ORG, sub: "s1", attributes: { first_name: "Grace" },
  });

  const sender = recordingSender();
  const descriptor: SendDescriptor = {
    orgId: ORG, campaignId: "c1", listId: "ledger", subject: "Hi",
    template: { blocks: [{ kind: "text", html: "<p>Hello {{first_name}}</p>" }] },
  };
  await sendCampaign(stores, sender, undefined, clock, descriptor, {
    segments: new GsiSegmentEngine(stores),
  });
  assert.equal(sender.sent.length, 1);
  assert.match(sender.sent[0]!.html, /Hello Grace/);
});

test("a removed attribute is actually gone, not merged away", async () => {
  // A merge cannot express "remove this", which is why the write is a full
  // replacement — a stale merge tag renders stale personalisation forever.
  const stores = await seed();
  const d = await setSubscriberAttributes(stores, { orgId: ORG, sub: "s1", attributes: { city: "Denver" } });
  assert.deepEqual(d.attributes, { city: "Denver" });
});

test("attributes are bounded by the same schema as the public signup path (#196)", async () => {
  // An admin screen is a lower-volume route to the same 400 KB item.
  const stores = await seed();
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"]));
  await assert.rejects(() => setSubscriberAttributes(stores, { orgId: ORG, sub: "s1", attributes: tooMany }));
  await assert.rejects(() =>
    setSubscriberAttributes(stores, { orgId: ORG, sub: "s1", attributes: { k: "v".repeat(1025) } }),
  );
  // …and the record is untouched by a rejected save.
  assert.deepEqual((await subscriberDetail(stores, ORG, "s1")).attributes, { first_name: "Ada" });
});

test("attribute VALUES are escaped at render, not mangled on the way in", async () => {
  // Sanitising here would corrupt a legitimate "Tom & Jerry" and would still
  // leave every value already in the table unescaped.
  const stores = await seed();
  const d = await setSubscriberAttributes(stores, {
    orgId: ORG, sub: "s1", attributes: { first_name: `Tom & <script>alert(1)</script>` },
  });
  assert.equal(d.attributes.first_name, `Tom & <script>alert(1)</script>`, "stored verbatim");

  const sender = recordingSender();
  await sendCampaign(stores, sender, undefined, clock, {
    orgId: ORG, campaignId: "c1", listId: "ledger", subject: "Hi",
    template: { blocks: [{ kind: "text", html: "<p>Hello {{first_name}}</p>" }] },
  }, { segments: new GsiSegmentEngine(stores) });
  assert.doesNotMatch(sender.sent[0]!.html, /<script>/, "escaped in the rendered body");
  assert.match(sender.sent[0]!.html, /Tom &amp; /);
});

// ---- per-list opt-ins ----

test("a subscriber can be opted into and out of ONE list", async () => {
  const stores = await seed();
  let d = await setSubscriptionStatus(stores, clock, {
    orgId: ORG, sub: "s1", listId: "weekly", status: "confirmed",
    acknowledgeManualConfirmation: true, actor: "admin-1",
  });
  assert.equal(d.lists.find((l) => l.listId === "weekly")?.status, "confirmed");
  // The other list is untouched — the old "unsubscribe all" was the only control.
  assert.equal(d.lists.find((l) => l.listId === "ledger")?.status, "confirmed");

  d = await setSubscriptionStatus(stores, clock, {
    orgId: ORG, sub: "s1", listId: "ledger", status: "unsubscribed",
  });
  assert.equal(d.lists.find((l) => l.listId === "ledger")?.status, "unsubscribed");
  assert.equal(d.lists.find((l) => l.listId === "weekly")?.status, "confirmed");
});

test("manual confirmation is REFUSED without an explicit acknowledgement", async () => {
  // It bypasses double opt-in, so it must never be reachable by a mis-click on a
  // dropdown or by a client that forgot the flag.
  const stores = await seed();
  await assert.rejects(
    () => setSubscriptionStatus(stores, clock, { orgId: ORG, sub: "s1", listId: "weekly", status: "confirmed" }),
    /bypasses double opt-in/,
  );
  assert.equal(
    (await subscriberDetail(stores, ORG, "s1")).lists.find((l) => l.listId === "weekly")?.status,
    undefined,
  );
});

test("unsubscribing needs no acknowledgement — only the dangerous direction does", async () => {
  const stores = await seed();
  const d = await setSubscriptionStatus(stores, clock, {
    orgId: ORG, sub: "s1", listId: "ledger", status: "unsubscribed",
  });
  assert.equal(d.lists.find((l) => l.listId === "ledger")?.status, "unsubscribed");
});

test("a manual confirmation records that a human did it, not a fake opt-in", async () => {
  // The record a consent dispute turns on. Writing `basis: "explicit"` — or
  // inventing a source URL — would make an administrative act indistinguishable
  // from a real signup.
  const stores = await seed();
  const d = await setSubscriptionStatus(stores, clock, {
    orgId: ORG, sub: "s1", listId: "weekly", status: "confirmed",
    acknowledgeManualConfirmation: true, actor: "admin-1",
  });
  const consent = d.lists.find((l) => l.listId === "weekly")?.consent;
  assert.equal(consent?.basis, "manual_admin");
  assert.equal(consent?.actor, "admin-1");
  assert.equal(consent?.sourceUrl, undefined, "no fabricated signup URL");
});

test("existing consent is never overwritten by an admin action", async () => {
  // The original provenance is the proof of the ORIGINAL opt-in. An admin
  // re-confirming is not a better version of it.
  const stores = await seed();
  await setSubscriptionStatus(stores, clock, {
    orgId: ORG, sub: "s1", listId: "ledger", status: "unsubscribed",
  });
  const d = await setSubscriptionStatus(stores, clock, {
    orgId: ORG, sub: "s1", listId: "ledger", status: "confirmed",
    acknowledgeManualConfirmation: true, actor: "admin-1",
  });
  const consent = d.lists.find((l) => l.listId === "ledger")?.consent;
  assert.equal(consent?.basis, "explicit", "the real double opt-in survives");
  assert.equal(consent?.confirmedAt, "2026-01-01T00:05:00.000Z");
});

test("a list that does not exist is refused", async () => {
  const stores = await seed();
  await assert.rejects(
    () => setSubscriptionStatus(stores, clock, { orgId: ORG, sub: "s1", listId: "ghost", status: "pending" }),
    /unknown list/,
  );
});

// ---- suppression still wins ----

test("suppression overrides every opt-in this screen can set", async () => {
  const stores = await seed();
  await stores.suppression.add({
    orgId: ORG, email: "reader@x.com", source: "complaint", scope: "org",
    addedAt: clock.now().toISOString(),
  });
  const d = await setSubscriptionStatus(stores, clock, {
    orgId: ORG, sub: "s1", listId: "weekly", status: "confirmed",
    acknowledgeManualConfirmation: true, actor: "admin-1",
  });
  // Confirmed on both lists, and mailable on neither. The panel says so.
  assert.equal(d.suppressed, true);
  assert.equal(d.lists.find((l) => l.listId === "weekly")?.status, "confirmed");

  const sender = recordingSender();
  const result = await sendCampaign(stores, sender, undefined, clock, {
    orgId: ORG, campaignId: "c1", listId: "ledger", subject: "Hi",
    template: { blocks: [{ kind: "text", html: "<p>hi</p>" }] },
  }, { segments: new GsiSegmentEngine(stores) });
  assert.deepEqual(sender.sent, [], "nothing may go out to a suppressed address");
  assert.equal(result.suppressed, 1);
});
