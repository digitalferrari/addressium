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
import type { Organization } from "@addressium/core";

const ORG = "summit";
const listInput = {
  orgId: ORG,
  listId: "ledger",
  name: "Ledger",
  optInPolicy: "double" as const,
  fromAddress: "l@northwindtimes.example",
  access: "free" as const,
  visibility: "open" as const,
  complianceFooter: "footer",
  physicalAddress: "123 Main St",
};

/**
 * A minimal org, needed because saveList now validates the From address against
 * the domains this org actually owns (#200).
 */
async function withOrg(domains = ["northwindtimes.example"]) {
  const stores = memStores();
  await stores.organizations.put({
    orgId: ORG,
    name: "Summit",
    domains,
    sesConfigSet: "cs",
    ipMode: "shared",
    suppressionScope: "hybrid",
    defaultTimezone: "UTC",
    setupComplete: true,
  });
  return stores;
}

test("saveList persists and lists newsletters per org", async () => {
  const stores = await withOrg();
  await saveList(stores, listInput);
  const all = await stores.lists.list(ORG);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.name, "Ledger");
});

test("setListVisibility opens/closes and rejects unknown lists", async () => {
  const stores = await withOrg();
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
    // A real predicate. This used to be `{ entitlement: "paid" }`, a shape the
    // engine could never have evaluated — `predicate: z.unknown()` accepted it
    // and nothing downstream would have matched anyone (#195).
    predicate: {
      match: "all",
      conditions: [
        { field: "list", op: "in", value: "ledger" },
        { field: "entitlement", op: "eq", value: "paid" },
      ],
    },
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

test("editing a draft does not wipe its schedule (#201)", async () => {
  // `saveCampaignDraft` rebuilt the record from its input alone, and the save
  // schema has no `schedule` field — scheduling goes through its own route — so
  // the draft editor could only ever destroy a send time, never set one.
  // Changing a subject on an already-scheduled campaign silently unscheduled it.
  const stores = memStores();
  const draft = {
    orgId: ORG,
    campaignId: "spring",
    type: "one_off" as const,
    subject: "Spring",
    templateId: "t1",
    audience: { listId: "ledger" },
  };
  await saveCampaignDraft(stores, draft);

  // Scheduled out of band, the way the schedule route does it.
  const scheduled = (await stores.campaigns.get(ORG, "spring"))!;
  await stores.campaigns.put({
    ...scheduled,
    status: "scheduled",
    schedule: { sendAt: "2026-08-01T09:00:00.000Z", timezone: "America/Denver" },
  });

  // A pure copy edit.
  const after = await saveCampaignDraft(stores, { ...draft, subject: "Spring, revised" });
  assert.equal(after.subject, "Spring, revised");
  assert.deepEqual(
    after.schedule,
    { sendAt: "2026-08-01T09:00:00.000Z", timezone: "America/Denver" },
    "the send time must survive a subject edit",
  );
  assert.equal(after.status, "scheduled", "and so must the status");
});

test("a brand-new draft has no schedule to preserve", async () => {
  const stores = memStores();
  const fresh = await saveCampaignDraft(stores, {
    orgId: ORG,
    campaignId: "new",
    type: "one_off",
    subject: "New",
    templateId: "t1",
    audience: { listId: "ledger" },
  });
  assert.equal(fresh.schedule, undefined);
  assert.equal(fresh.status, "draft");
});

// ---- From-address ownership (#200) ----

test("a From address on a domain the org does not own is REFUSED", async () => {
  // It used to be taken verbatim, with enforcement left to SES. That defers the
  // failure to SEND time on a scheduled campaign, as an opaque SES error — and
  // in a multi-tenant deployment it is not even enforcement: two orgs verified
  // in the same AWS account can each send as the other's domain, because SES
  // checks the ACCOUNT's identities, not the tenant's.
  const stores = await withOrg(["northwindtimes.example"]);
  await assert.rejects(
    () => saveList(stores, { ...listInput, fromAddress: "l@someoneelse.example" }),
    /not on a domain this org owns/,
  );
});

test("a subdomain of an owned domain is allowed", async () => {
  // An SES domain identity covers its subdomains: verifying `example.com` lets
  // you send as `news@mail.example.com`, and refusing that would block the
  // normal marketing/transactional subdomain split.
  const stores = await withOrg(["northwindtimes.example"]);
  const list = await saveList(stores, { ...listInput, fromAddress: "l@news.northwindtimes.example" });
  assert.equal(list.fromAddress, "l@news.northwindtimes.example");
});

test("a domain that merely ENDS WITH an owned one is refused", async () => {
  // The suffix check is anchored on a leading dot. Without that anchor,
  // `notnorthwindtimes.example` passes an `endsWith` against
  // `northwindtimes.example` — a lookalike domain registered by anyone.
  const stores = await withOrg(["northwindtimes.example"]);
  await assert.rejects(
    () => saveList(stores, { ...listInput, fromAddress: "l@notnorthwindtimes.example" }),
    /not on a domain this org owns/,
  );
});

test("the check is case-insensitive and covers the site domain too", async () => {
  const stores = await withOrg(["northwindtimes.example", "Summit.Example"]);
  await saveList(stores, { ...listInput, fromAddress: "l@SUMMIT.example" });
});

test("saving a list for an org that does not exist fails loudly", async () => {
  const stores = memStores();
  await assert.rejects(() => saveList(stores, listInput), /unknown org/);
});
