/**
 * Admin CRUD: save/list newsletters, open/close, campaign drafts (counters
 * preserved on edit), segments, and manual suppression (adds entry + flips the
 * subscriber).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Subscriber } from "@addressium/core";
import {
  memStores,
  SystemClock,
  saveList,
  setListVisibility,
  saveCampaignDraft,
  saveSegment,
  manualSuppress,
} from "@addressium/domain";

const ORG = "summit";
const listInput = {
  orgId: ORG,
  listId: "ledger",
  name: "Ledger",
  optInPolicy: "double" as const,
  fromAddress: "l@summitdaily.com",
  access: "free" as const,
  visibility: "open" as const,
  complianceFooter: "footer",
  physicalAddress: "123 Main St",
};

test("saveList persists and lists newsletters per org", async () => {
  const stores = memStores();
  await saveList(stores, listInput);
  const all = await stores.lists.list(ORG);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.name, "Ledger");
});

test("setListVisibility opens/closes and rejects unknown lists", async () => {
  const stores = memStores();
  await saveList(stores, listInput);
  const closed = await setListVisibility(stores, ORG, "ledger", "closed");
  assert.equal(closed.visibility, "closed");
  await assert.rejects(() => setListVisibility(stores, ORG, "nope", "closed"), /unknown list/);
});

test("saveCampaignDraft creates a draft and preserves status/counters on edit", async () => {
  const stores = memStores();
  const draft = await saveCampaignDraft(stores, {
    orgId: ORG,
    campaignId: "c1",
    type: "one_off",
    subject: "Hello",
    templateId: "t1",
    audience: { listId: "ledger" },
  });
  assert.equal(draft.status, "draft");
  assert.equal(draft.counters.sent, 0);

  // Simulate a send having advanced status/counters, then an edit.
  await stores.campaigns.put({ ...draft, status: "sent", counters: { ...draft.counters, sent: 10 } });
  const edited = await saveCampaignDraft(stores, {
    orgId: ORG,
    campaignId: "c1",
    type: "one_off",
    subject: "Hello (edited)",
    templateId: "t1",
    audience: { listId: "ledger" },
  });
  assert.equal(edited.subject, "Hello (edited)");
  assert.equal(edited.status, "sent"); // preserved
  assert.equal(edited.counters.sent, 10); // preserved
});

test("saveSegment persists a segment definition", async () => {
  const stores = memStores();
  const seg = await saveSegment(stores, {
    orgId: ORG,
    segmentId: "paid",
    name: "Paid subscribers",
    predicate: { entitlement: "paid" },
  });
  assert.equal(seg.name, "Paid subscribers");
  assert.equal((await stores.segments.list(ORG)).length, 1);
});

test("manualSuppress adds an org-scoped entry and flips the subscriber", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  const sub: Subscriber = {
    orgId: ORG,
    sub: "s1",
    email: "x@y.com",
    attributes: {},
    status: "active",
    entitlement: "free",
  };
  await stores.subscribers.put(sub);

  const result = await manualSuppress(stores, clock, { orgId: ORG, email: "X@Y.com" });
  assert.equal(result.subscriberFlipped, true);
  assert.equal(await stores.suppression.isSuppressed(ORG, "x@y.com"), true);
  assert.equal((await stores.subscribers.get(ORG, "s1"))?.status, "suppressed");
  // org-scoped, not global
  assert.equal(await stores.suppression.isSuppressed("other", "x@y.com"), false);
});
