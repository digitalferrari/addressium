/**
 * Pausing a one-off must defer it, not destroy it (#179).
 *
 * The sequence that lost sends silently: the one-off EventBridge schedule fires
 * → `ActionAfterCompletion: DELETE` removes it → the message lands on SQS → the
 * sender sees `paused` and returns `{skipped: true}` → SQS deletes the message.
 * Nothing remains. Resume-then-Start produced no send at all, and the campaign
 * simply never went out.
 *
 * The comment in `sendCampaign` claimed the gate was checked early "so resuming
 * can still send later". It wasn't true.
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

test("a paused one-off parks its send instead of dropping it", async () => {
  const stores = await seeded();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "pause" });

  const sender = new CaptureSender();
  const out = await sendCampaign(stores, sender, undefined, clock, descriptor, {});
  assert.equal(out.skipped, true);
  assert.deepEqual(sender.sent, [], "paused means nothing goes out now");

  const parked = (await stores.schedules.get(ORG, CAMPAIGN))?.deferred as SendDescriptor | undefined;
  assert.ok(parked, "the send must survive the message being deleted");
  assert.equal(parked.subject, "Spring");
  assert.equal(parked.campaignId, CAMPAIGN);
});

test("resuming hands the parked send back so it can be re-enqueued", async () => {
  const stores = await seeded();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "pause" });
  await sendCampaign(stores, new CaptureSender(), undefined, clock, descriptor, {});

  const resumedState = await transitionSchedule(stores, clock, {
    orgId: ORG,
    scheduleId: CAMPAIGN,
    action: "start",
  });
  const resumed = (resumedState as { resumed?: SendDescriptor }).resumed;
  assert.ok(resumed, "resume must return the send so the API can re-enqueue it");
  assert.equal(resumed.campaignId, CAMPAIGN);

  // ...and the parked copy is cleared, so a second resume does not re-send.
  assert.equal((await stores.schedules.get(ORG, CAMPAIGN))?.deferred, undefined);
  const second = await transitionSchedule(stores, clock, {
    orgId: ORG,
    scheduleId: CAMPAIGN,
    action: "start",
  });
  assert.equal((second as { resumed?: SendDescriptor }).resumed, undefined, "resume is not a re-send button");
});

test("the re-enqueued send actually delivers", async () => {
  // End to end: pause, fire, resume, deliver. This is the acceptance criterion —
  // "pause → resume on a one-off results in the campaign actually sending".
  const stores = await seeded();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "pause" });
  await sendCampaign(stores, new CaptureSender(), undefined, clock, descriptor, {});

  const state = await transitionSchedule(stores, clock, {
    orgId: ORG,
    scheduleId: CAMPAIGN,
    action: "start",
  });
  const resumed = (state as { resumed?: SendDescriptor }).resumed!;

  const sender = new CaptureSender();
  const out = await sendCampaign(stores, sender, undefined, clock, resumed, {});
  assert.equal(out.sent, 1);
  assert.equal(sender.sent[0]?.to, "reader@x.com");
});

test("archive is terminal — it discards the parked send", async () => {
  // The other acceptance criterion. A terminal state that leaves a send waiting
  // to fire is not terminal.
  const stores = await seeded();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "pause" });
  await sendCampaign(stores, new CaptureSender(), undefined, clock, descriptor, {});
  assert.ok((await stores.schedules.get(ORG, CAMPAIGN))?.deferred, "parked while paused");

  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "archive" });
  assert.equal((await stores.schedules.get(ORG, CAMPAIGN))?.deferred, undefined);

  const sender = new CaptureSender();
  const out = await sendCampaign(stores, sender, undefined, clock, descriptor, {});
  assert.equal(out.skipped, true);
  assert.deepEqual(sender.sent, [], "archived stays stopped");
});

test("an archived send is dropped, never parked", async () => {
  // Parking an archived send would resurrect it the moment someone hit Start.
  const stores = await seeded();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "archive" });
  await sendCampaign(stores, new CaptureSender(), undefined, clock, descriptor, {});
  assert.equal((await stores.schedules.get(ORG, CAMPAIGN))?.deferred, undefined);
});

test("parking is idempotent under SQS redelivery", async () => {
  const stores = await seeded();
  await transitionSchedule(stores, clock, { orgId: ORG, scheduleId: CAMPAIGN, action: "pause" });
  for (let i = 0; i < 3; i++) {
    await sendCampaign(stores, new CaptureSender(), undefined, clock, descriptor, {});
  }
  const parked = (await stores.schedules.get(ORG, CAMPAIGN))?.deferred as SendDescriptor;
  assert.equal(parked.campaignId, CAMPAIGN, "one parked send, not three");
});

test("an active one-off is unaffected", async () => {
  const stores = await seeded();
  const sender = new CaptureSender();
  const out = await sendCampaign(stores, sender, undefined, clock, descriptor, {});
  assert.equal(out.sent, 1);
  assert.equal((await stores.schedules.get(ORG, CAMPAIGN))?.deferred, undefined);
});
