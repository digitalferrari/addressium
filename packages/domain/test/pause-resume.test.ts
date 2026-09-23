/**
 * Pausing a one-off SKIPS the firing — it neither parks it nor destroys it
 * (#304, superseding #179).
 *
 * Three behaviours in sequence, and the history matters because each fixed the
 * one before:
 *
 * Originally a pause DESTROYED the send: the one-off schedule fired,
 * `ActionAfterCompletion: DELETE` removed it, the message landed on SQS, the
 * sender saw `paused` and returned `{skipped: true}`, and SQS deleted the
 * message. Nothing remained. Resume-then-Start produced no send at all.
 *
 * #179 fixed that by PARKING the descriptor on the lifecycle record and
 * re-enqueuing it on resume. That solved the data loss and introduced a
 * surprise: resuming days or weeks later mailed a send nobody was expecting,
 * with content that had gone stale.
 *
 * #304 is the third option. The firing is skipped, the lifecycle record and the
 * campaign both survive, and nothing is queued behind the pause. A missed send
 * stays missed; an operator who still wants it reschedules or duplicates it,
 * which is an explicit act rather than something that happens to them. This
 * also makes one-offs behave like recurring series, which have always skipped.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { List } from "@addressium/core";
import {
  CaptureSender,
  markScheduleActive,
  memStores,
  sendCampaign,
  transitionSchedule,
  type Clock,
  type EmailTemplate,
  type SendDescriptor,
  type Stores,
} from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";
const CAMPAIGN = "spring-launch";
const clock: Clock = { now: () => new Date("2026-07-28T12:00:00.000Z") };
const template: EmailTemplate = { html: "<p>hello</p>" };

async function seeded(): Promise<Stores> {
  const stores = memStores();
  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "a@b.co",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "p",
  };
  await stores.lists.put(list);
  await stores.subscribers.put({
    orgId: ORG,
    sub: "s1",
    email: "reader@x.com",
    attributes: {},
    status: "active",
    entitlement: "free",
  });
  await stores.subscriptions.put({
    orgId: ORG,
    subscriberId: "s1",
    listId: LIST,
    status: "confirmed",
    updatedAt: "t",
  });
  await markScheduleActive(stores, clock, {
    orgId: ORG,
    scheduleId: CAMPAIGN,
    kind: "one_off",
  });
  return stores;
}

const descriptor = {
  orgId: ORG,
  campaignId: CAMPAIGN,
  listId: LIST,
  subject: "Spring",
  template,
};

test("a paused one-off skips the firing without sending", async () => {
  const stores = await seeded();
  const sender = new CaptureSender();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "pause" });

  const result = await sendCampaign(stores, sender, undefined, clock, descriptor, {});

  assert.equal(result.skipped, true);
  assert.equal(sender.sent.length, 0, "a paused schedule sends nothing");
});

test("nothing is parked, so resuming does not fire a stale send", async () => {
  // The #179 behaviour this replaces: resume re-enqueued the parked descriptor,
  // so an operator resuming a week later mailed content nobody had looked at.
  const stores = await seeded();
  const sender = new CaptureSender();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "pause" });
  await sendCampaign(stores, sender, undefined, clock, descriptor, {});

  const resumed = await transitionSchedule(stores, clock, {
    orgId: ORG,
    scheduleId: CAMPAIGN,
    action: "start",
  });

  assert.equal(resumed.status, "active");
  assert.equal(
    (resumed as { resumed?: unknown }).resumed,
    undefined,
    "resume must not hand back a send to re-enqueue",
  );
  assert.equal(sender.sent.length, 0, "and nothing is delivered by resuming");
});

test("the lifecycle record survives a pause — only the firing is lost", async () => {
  // Skipping is not the original bug returning. The schedule and the campaign
  // both remain, so the operator can reschedule; it is the QUEUED send that is
  // gone, not the record of it.
  const stores = await seeded();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "pause" });
  await sendCampaign(stores, new CaptureSender(), undefined, clock, descriptor, {});

  const state = await stores.schedules.get(ORG, CAMPAIGN);
  assert.ok(state, "the lifecycle record is still there");
  assert.equal(state.status, "paused");
  assert.equal(state.deferred, undefined, "and carries nothing waiting to fire");
});

test("a resumed schedule sends normally on its next firing", async () => {
  const stores = await seeded();
  const sender = new CaptureSender();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "pause" });
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "start" });

  const result = await sendCampaign(stores, sender, undefined, clock, descriptor, {});

  assert.ok(!result.skipped, "an active schedule is not skipped");
  assert.equal(sender.sent.length, 1, "an active schedule sends");
});

test("an archived send is dropped, and stays dropped", async () => {
  const stores = await seeded();
  const sender = new CaptureSender();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "archive" });

  await sendCampaign(stores, sender, undefined, clock, descriptor, {});
  assert.equal(sender.sent.length, 0);

  const state = await stores.schedules.get(ORG, CAMPAIGN);
  assert.equal(state?.status, "archived");
  assert.equal(state?.deferred, undefined);
});

test("a legacy parked descriptor is cleared rather than left to fire", async () => {
  // A record written before #304 may still carry `deferred`. Leaving it would
  // mean an operator pausing and resuming an old schedule still gets the
  // surprise send this change removes.
  const stores = await seeded();
  const existing = await stores.schedules.get(ORG, CAMPAIGN);
  await stores.schedules.put({ ...existing!, deferred: { stale: true } as never });

  const after = await transitionSchedule(stores, clock, {
    orgId: ORG,
    scheduleId: CAMPAIGN,
    action: "start",
  });

  assert.equal(after.deferred, undefined, "the stale parked send must not survive");
});

test("an active one-off is unaffected", async () => {
  const stores = await seeded();
  const sender = new CaptureSender();
  const result = await sendCampaign(stores, sender, undefined, clock, descriptor, {});
  assert.ok(!result.skipped, "an active schedule is not skipped");
  assert.equal(sender.sent.length, 1);
});
