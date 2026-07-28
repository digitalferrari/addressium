/**
 * Explicit-membership segments (#203) — a hand-curated test cohort.
 *
 * Two things had to be true for this feature to be worth anything, and neither
 * was: an operator needed a way to enumerate members from the console, and the
 * SEND PATH needed to honour a segment at all. It did not — `sendCampaign`
 * resolved recipients from `listConfirmed` and never looked at `segmentId`, so a
 * campaign saved against a segment mailed the entire list. That is the failure
 * these tests are mostly about; the membership editor is the easy half.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  memStores,
  saveSegment,
  listSegmentMembers,
  updateSegmentMembership,
  sendCampaign,
  fanOutCampaign,
  SystemClock,
  type EmailSender,
  type SendQueue,
  type SendDescriptor,
  type Stores,
} from "@addressium/domain";
import { GsiSegmentEngine } from "@addressium/segment";
import type { List, Subscriber, Subscription } from "@addressium/core";

const ORG = "summit";
const LIST = "ledger";
const SEG = "test-cohort";
const clock = new SystemClock();

/** Records what actually went out, which is the only thing worth asserting. */
function recordingSender(): EmailSender & { to: string[] } {
  const to: string[] = [];
  return {
    to,
    async send(msg) {
      to.push(msg.to);
    },
  };
}

async function seed(people: Array<[string, string]> = [["a", "a@x.com"], ["b", "b@x.com"], ["c", "c@x.com"]]) {
  const stores = memStores();
  const list: List = {
    orgId: ORG, listId: LIST, name: "Ledger", optInPolicy: "double",
    fromAddress: "l@x.com", access: "free", visibility: "open",
    complianceFooter: "f", physicalAddress: "1 Main St",
  };
  await stores.lists.put(list);
  for (const [id, email] of people) {
    const sub: Subscriber = {
      orgId: ORG, sub: id, email, attributes: {}, status: "active", entitlement: "free",
    };
    await stores.subscribers.put(sub);
    const s: Subscription = {
      orgId: ORG, subscriberId: id, listId: LIST, status: "confirmed", updatedAt: "",
    };
    await stores.subscriptions.put(s);
  }
  await saveSegment(stores, {
    orgId: ORG, segmentId: SEG, name: "Test cohort",
    predicate: { match: "explicit", subscriberIds: [] },
  });
  return stores;
}

const descriptor = (over: Partial<SendDescriptor> = {}): SendDescriptor => ({
  orgId: ORG,
  campaignId: "c1",
  listId: LIST,
  subject: "Hello",
  template: { blocks: [{ kind: "text", html: "<p>hi</p>" }] },
  ...over,
});

// ---- membership editing ----

test("addresses go in one at a time and the count follows", async () => {
  const stores = await seed();
  let members = (await updateSegmentMembership(stores, {
    orgId: ORG, segmentId: SEG, action: "add", email: "a@x.com",
  })).members;
  assert.equal(members.length, 1);
  members = (await updateSegmentMembership(stores, {
    orgId: ORG, segmentId: SEG, action: "add", email: "b@x.com",
  })).members;
  assert.deepEqual(members.map((m) => m.email).sort(), ["a@x.com", "b@x.com"]);

  members = (await updateSegmentMembership(stores, {
    orgId: ORG, segmentId: SEG, action: "remove", email: "a@x.com",
  })).members;
  assert.deepEqual(members.map((m) => m.email), ["b@x.com"]);
});

test("adding the same address twice is idempotent, not a duplicate", async () => {
  // A double-click must not put the recipient in the cohort twice — and if it
  // did, the send would claim them once and silently report a smaller send.
  const stores = await seed();
  await updateSegmentMembership(stores, { orgId: ORG, segmentId: SEG, action: "add", email: "a@x.com" });
  const { members } = await updateSegmentMembership(stores, {
    orgId: ORG, segmentId: SEG, action: "add", email: "a@x.com",
  });
  assert.equal(members.length, 1);
});

test("the address is matched case-insensitively", async () => {
  const stores = await seed();
  const { members } = await updateSegmentMembership(stores, {
    orgId: ORG, segmentId: SEG, action: "add", email: "  A@X.com ",
  });
  assert.equal(members[0]?.email, "a@x.com");
});

test("an address that is not a subscriber is REJECTED, not created", async () => {
  // The documented decision (#203 asked for one). Every other path that creates
  // a subscriber records consent provenance — a signup captures a source URL and
  // timestamp, an import captures a consent basis and a batch id. One conjured
  // from a segment-editor text box has none, and is indistinguishable afterwards
  // from one that does. Building a test cohort is not a lawful basis to mail.
  const stores = await seed();
  await assert.rejects(
    () => updateSegmentMembership(stores, {
      orgId: ORG, segmentId: SEG, action: "add", email: "stranger@x.com",
    }),
    /not a subscriber/,
  );
  assert.equal((await listSegmentMembers(stores, ORG, SEG)).length, 0);
});

test("a rule-based segment refuses membership edits rather than silently rewriting itself", async () => {
  const stores = await seed();
  await saveSegment(stores, {
    orgId: ORG, segmentId: "rule-seg", name: "Paid",
    predicate: { match: "all", conditions: [{ field: "list", op: "in", value: LIST }] },
  });
  await assert.rejects(
    () => updateSegmentMembership(stores, {
      orgId: ORG, segmentId: "rule-seg", action: "add", email: "a@x.com",
    }),
    /rule-based/,
  );
});

test("a member id that no longer resolves drops out instead of showing as a blank row", async () => {
  // Ids outlive the subscribers they name — an erasure (#101) or a hard delete
  // leaves the cohort holding a dangling id. Listing it would invite an operator
  // to "fix" a row that is already correct, and yielding it to the send path
  // would burn a send claim before failing with "unknown subscriber".
  const stores = await seed();
  await updateSegmentMembership(stores, { orgId: ORG, segmentId: SEG, action: "add", email: "a@x.com" });
  await saveSegment(stores, {
    orgId: ORG, segmentId: SEG, name: "Test cohort",
    predicate: { match: "explicit", subscriberIds: ["a", "ghost"] },
  });
  const members = await listSegmentMembers(stores, ORG, SEG);
  assert.deepEqual(members.map((m) => m.email), ["a@x.com"]);

  const sender = recordingSender();
  const result = await sendCampaign(stores, sender, undefined, clock, descriptor({ segmentId: SEG }), {
    segments: new GsiSegmentEngine(stores),
  });
  assert.equal(result.sent, 1);
});

// ---- the send path ----

test("a segment-targeted send reaches exactly the cohort", async () => {
  // The acceptance criterion, and the bug: this used to mail a@, b@ AND c@,
  // because the send path never looked at the segment.
  const stores = await seed();
  await updateSegmentMembership(stores, { orgId: ORG, segmentId: SEG, action: "add", email: "a@x.com" });
  await updateSegmentMembership(stores, { orgId: ORG, segmentId: SEG, action: "add", email: "c@x.com" });

  const sender = recordingSender();
  const result = await sendCampaign(stores, sender, undefined, clock, descriptor({ segmentId: SEG }), {
    segments: new GsiSegmentEngine(stores),
  });
  assert.equal(result.sent, 2);
  assert.deepEqual(sender.to.sort(), ["a@x.com", "c@x.com"]);
});

test("no segment still means the whole list", async () => {
  // A guard that quietly narrows every send would be worse than the bug.
  const stores = await seed();
  const sender = recordingSender();
  const result = await sendCampaign(stores, sender, undefined, clock, descriptor(), {
    segments: new GsiSegmentEngine(stores),
  });
  assert.equal(result.sent, 3);
});

test("a segment member who unsubscribed from the list is NOT mailed", async () => {
  // Segment membership is not consent. The cohort is intersected with the
  // confirmed set, never used in its place.
  const stores = await seed();
  await updateSegmentMembership(stores, { orgId: ORG, segmentId: SEG, action: "add", email: "a@x.com" });
  await updateSegmentMembership(stores, { orgId: ORG, segmentId: SEG, action: "add", email: "b@x.com" });
  await stores.subscriptions.put({
    orgId: ORG, subscriberId: "b", listId: LIST, status: "unsubscribed", updatedAt: "",
  });

  const sender = recordingSender();
  const result = await sendCampaign(stores, sender, undefined, clock, descriptor({ segmentId: SEG }), {
    segments: new GsiSegmentEngine(stores),
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(sender.to, ["a@x.com"]);
});

test("a suppressed member is skipped even from a test segment", async () => {
  const stores = await seed();
  await updateSegmentMembership(stores, { orgId: ORG, segmentId: SEG, action: "add", email: "a@x.com" });
  await updateSegmentMembership(stores, { orgId: ORG, segmentId: SEG, action: "add", email: "b@x.com" });
  await stores.suppression.add({
    orgId: ORG, email: "b@x.com", source: "manual", scope: "org", addedAt: clock.now().toISOString(),
  });

  // Surfaced in the console too, so an operator does not read the short send as
  // a broken feature.
  const members = await listSegmentMembers(stores, ORG, SEG);
  assert.equal(members.find((m) => m.email === "b@x.com")?.suppressed, true);
  assert.equal(members.find((m) => m.email === "a@x.com")?.suppressed, false);

  const sender = recordingSender();
  const result = await sendCampaign(stores, sender, undefined, clock, descriptor({ segmentId: SEG }), {
    segments: new GsiSegmentEngine(stores),
  });
  assert.deepEqual(sender.to, ["a@x.com"]);
  assert.equal(result.suppressed, 1);
});

test("a segment-targeted send with no resolver REFUSES rather than mailing everyone", async () => {
  // The two failure directions are not symmetric. Sending to nobody is a visible
  // mistake fixed in a minute; sending a test campaign to the whole list is
  // unrecallable. Fail closed.
  const stores = await seed();
  await updateSegmentMembership(stores, { orgId: ORG, segmentId: SEG, action: "add", email: "a@x.com" });
  const sender = recordingSender();
  await assert.rejects(
    () => sendCampaign(stores, sender, undefined, clock, descriptor({ segmentId: SEG }), {}),
    /no segment resolver/,
  );
  assert.deepEqual(sender.to, [], "nothing may go out");
});

test("a segment that has been deleted refuses the send", async () => {
  const stores = await seed();
  const sender = recordingSender();
  await assert.rejects(
    () => sendCampaign(stores, sender, undefined, clock, descriptor({ segmentId: "gone" }), {
      segments: new GsiSegmentEngine(stores),
    }),
    /unknown segment/,
  );
  assert.deepEqual(sender.to, []);
});

test("fan-out slices the SEGMENT, not the list", async () => {
  // Slicing the list and filtering per slice would enqueue mostly-empty messages
  // — for a 3-address cohort on a 200-address list, dozens of them — and the key
  // ranges would no longer tile the set the sender actually walks.
  const people: Array<[string, string]> = Array.from({ length: 40 }, (_, i) => [
    `s${String(i).padStart(2, "0")}`,
    `s${String(i).padStart(2, "0")}@x.com`,
  ]);
  const stores = await seed(people);
  for (let i = 0; i < 10; i++) {
    await updateSegmentMembership(stores, {
      orgId: ORG, segmentId: SEG, action: "add", email: people[i]![1],
    });
  }

  const enqueued: SendDescriptor[] = [];
  const queue: SendQueue = { enqueue: async (d) => void enqueued.push(d as SendDescriptor) };

  // Chunk 4 over a 10-member cohort → 3 slices. Over the 40-member list it would
  // be 10, which is the symptom of filtering in the wrong order.
  const slices = await fanOutCampaign(
    stores as Stores, queue, descriptor({ segmentId: SEG }), 4, new GsiSegmentEngine(stores),
  );
  assert.equal(slices.length, 3);

  // And the slices together deliver the cohort exactly once.
  const sender = recordingSender();
  for (const d of enqueued) {
    await sendCampaign(stores, sender, undefined, clock, d, { segments: new GsiSegmentEngine(stores) });
  }
  assert.equal(sender.to.length, 10);
  assert.equal(new Set(sender.to).size, 10, "no recipient may be sent twice across slices");
});
