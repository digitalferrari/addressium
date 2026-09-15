/**
 * Send-schedule lifecycle (§4.6): start / pause / archive, never delete. A
 * paused or archived schedule stops future sends — recurring at the launch
 * handler, one-off at the campaign sender — and a paused one can be resumed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "jose";
import type { List } from "@addressium/core";
import {
  memStores,
  CaptureSender,
  HmacConfirmationSigner,
  SystemClock,
  JoseMagicLinkSigner,
  signup,
  confirmOptIn,
  sendCampaign,
  scheduleActive,
  markScheduleActive,
  transitionSchedule,
  completeScheduleRange,
  ConcurrentModificationError,
  planFanOut,
  type EmailTemplate,
} from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";
const template: EmailTemplate = {
  blocks: [{ kind: "editorial", label: "read", url: "https://summitdaily.example/a" }],
};

async function harness() {
  const stores = memStores();
  const sender = new CaptureSender();
  const clock = new SystemClock();
  const confirmSigner = new HmacConfirmationSigner("secret");
  const { privateKey } = await generateKeyPair("ES256");
  const magic = new JoseMagicLinkSigner(
    { privateKey, kid: "k1", issuer: "iss", audience: "aud", ttlSeconds: 3600 },
    clock,
  );
  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "l@summitdaily.example",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "a",
  };
  await stores.lists.put(list);
  return { stores, sender, clock, confirmSigner, magic };
}
type H = Awaited<ReturnType<typeof harness>>;
async function confirmed(h: H, email: string) {
  const r = await signup(h.stores, h.confirmSigner, h.clock, { orgId: ORG, email, listId: LIST });
  await confirmOptIn(h.stores, h.confirmSigner, h.clock, r.confirmationToken);
  return r.subscriber;
}
function send(h: H, campaignId: string) {
  return sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG, campaignId, listId: LIST, subject: "x", template,
  });
}

test("scheduleActive: undefined (legacy) and active fire; paused/archived don't", () => {
  assert.equal(scheduleActive(undefined), true);
  const base = { orgId: ORG, scheduleId: "c1", kind: "one_off" as const, createdAt: "t", updatedAt: "t" };
  assert.equal(scheduleActive({ ...base, status: "active" }), true);
  assert.equal(scheduleActive({ ...base, status: "paused" }), false);
  assert.equal(scheduleActive({ ...base, status: "archived" }), false);
  assert.equal(scheduleActive({ ...base, status: "completed" }), false);
});

test("markScheduleActive records active and preserves createdAt on resume", async () => {
  const h = await harness();
  const first = await markScheduleActive(h.stores, h.clock, {
    orgId: ORG, scheduleId: "daily", kind: "recurring", cron: "cron(0 6 * * ? *)", timezone: "UTC",
  });
  assert.equal(first.status, "active");
  await transitionSchedule(h.stores, h.clock, { orgId: ORG, scheduleId: "daily", action: "pause" });
  const resumed = await markScheduleActive(h.stores, h.clock, {
    orgId: ORG, scheduleId: "daily", kind: "recurring",
  });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.createdAt, first.createdAt); // identity/history preserved
  assert.equal(resumed.cron, "cron(0 6 * * ? *)"); // carried forward
});

test("a one-off records its send time, and a pause/resume does not lose it (#248)", async () => {
  const h = await harness();
  const at = "2026-07-21T15:30:00.000Z";
  const first = await markScheduleActive(h.stores, h.clock, {
    orgId: ORG, scheduleId: "c1", kind: "one_off", sendAt: at, timezone: "America/Denver",
  });
  assert.equal(first.sendAt, at);

  // Resume passes `{orgId, scheduleId, kind}` and nothing more. A one-off that
  // forgot its send time here would render "—" on the Schedules screen — the
  // screen an operator is on precisely because they mean to cancel it.
  await transitionSchedule(h.stores, h.clock, { orgId: ORG, scheduleId: "c1", action: "pause" });
  const resumed = await markScheduleActive(h.stores, h.clock, {
    orgId: ORG, scheduleId: "c1", kind: "one_off",
  });
  assert.equal(resumed.sendAt, at);
  assert.equal(resumed.timezone, "America/Denver");
  assert.equal((await h.stores.schedules.get(ORG, "c1"))?.sendAt, at);
});

test("converting a one-off to recurring clears the stale send time (#248)", async () => {
  const h = await harness();
  await markScheduleActive(h.stores, h.clock, {
    orgId: ORG, scheduleId: "c2", kind: "one_off", sendAt: "2026-07-21T15:30:00.000Z",
  });
  // A recurring series has no single send time; its cron is the answer. Left in
  // place, the old instant would keep being rendered as a deadline that has
  // nothing to do with when the series actually fires.
  const series = await markScheduleActive(h.stores, h.clock, {
    orgId: ORG, scheduleId: "c2", kind: "recurring", cron: "cron(0 6 * * ? *)", timezone: "UTC",
  });
  assert.equal(series.sendAt, undefined);
  assert.equal((await h.stores.schedules.get(ORG, "c2"))?.sendAt, undefined);
  assert.equal(series.cron, "cron(0 6 * * ? *)");
});

test("a recurring schedule never acquires a send time, even if one is passed", async () => {
  const h = await harness();
  const s = await markScheduleActive(h.stores, h.clock, {
    orgId: ORG, scheduleId: "daily2", kind: "recurring", cron: "cron(0 6 * * ? *)",
    sendAt: "2026-07-21T15:30:00.000Z",
  });
  assert.equal(s.sendAt, undefined);
});

test("transitionSchedule throws for an unknown schedule", async () => {
  const h = await harness();
  await assert.rejects(
    () => transitionSchedule(h.stores, h.clock, { orgId: ORG, scheduleId: "nope", action: "pause" }),
    /unknown schedule/,
  );
});

test("a paused one-off does not send, and does not burn its idempotency claim", async () => {
  const h = await harness();
  await confirmed(h, "reader@example.com");
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "c1", kind: "one_off" });

  await transitionSchedule(h.stores, h.clock, { orgId: ORG, scheduleId: "c1", action: "pause" });
  const paused = await send(h, "c1");
  assert.equal(paused.sent, 0);
  assert.equal(paused.skipped, true);
  assert.equal(h.sender.sent.length, 0);

  // Resume → the same campaign id can now send (claim was never consumed).
  await transitionSchedule(h.stores, h.clock, { orgId: ORG, scheduleId: "c1", action: "start" });
  const resumed = await send(h, "c1");
  assert.equal(resumed.sent, 1);
});

test("an archived one-off never sends", async () => {
  const h = await harness();
  await confirmed(h, "reader@example.com");
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "c2", kind: "one_off" });
  await transitionSchedule(h.stores, h.clock, { orgId: ORG, scheduleId: "c2", action: "archive" });
  const r = await send(h, "c2");
  assert.equal(r.sent, 0);
  assert.equal(h.sender.sent.length, 0);
});

test("an active (or unrecorded) one-off sends normally", async () => {
  const h = await harness();
  await confirmed(h, "reader@example.com");
  // No schedule record at all → treated as active (legacy path).
  assert.equal((await send(h, "legacy")).sent, 1);
});

test("schedules.list returns an org's lifecycle records", async () => {
  const h = await harness();
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "a", kind: "one_off" });
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "b", kind: "recurring" });
  await markScheduleActive(h.stores, h.clock, { orgId: "other", scheduleId: "c", kind: "one_off" });
  const rows = await h.stores.schedules.list(ORG);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.scheduleId).sort(), ["a", "b"]);
});

test("successful one-off completes, rejects restart/pause, and replay cannot send to new subscribers", async () => {
  const h = await harness();
  await confirmed(h, "first@example.com");
  const initial = await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "done", kind: "one_off" });
  assert.equal((await send(h, "done")).sent, 1);
  const done = await h.stores.schedules.get(ORG, "done");
  assert.equal(done?.status, "completed");
  assert.equal(done?.createdAt, initial.createdAt);
  await confirmed(h, "later@example.com");
  assert.equal((await send(h, "done")).skipped, true);
  assert.equal(h.sender.sent.length, 1);
  for (const action of ["start", "pause"] as const) {
    await assert.rejects(transitionSchedule(h.stores, h.clock, { orgId: ORG, scheduleId: "done", action }), /completed/);
  }
  await transitionSchedule(h.stores, h.clock, { orgId: ORG, scheduleId: "done", action: "archive" });
  await assert.rejects(transitionSchedule(h.stores, h.clock, { orgId: ORG, scheduleId: "done", action: "start" }), /completed/);
  await assert.rejects(markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "done", kind: "one_off" }), /completed/);
});

test("empty and fully suppressed one-offs complete; recurring and legacy sends keep their lifecycle", async () => {
  const h = await harness();
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "empty", kind: "one_off" });
  await send(h, "empty");
  assert.equal((await h.stores.schedules.get(ORG, "empty"))?.status, "completed");
  const sub = await confirmed(h, "blocked@example.com");
  await h.stores.subscribers.put({ ...sub, status: "suppressed" });
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "blocked", kind: "one_off" });
  assert.equal((await send(h, "blocked")).suppressed, 1);
  assert.equal((await h.stores.schedules.get(ORG, "blocked"))?.status, "completed");
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "series", kind: "recurring" });
  await send(h, "series");
  assert.equal((await h.stores.schedules.get(ORG, "series"))?.status, "active");
  await send(h, "legacy");
  assert.equal(await h.stores.schedules.get(ORG, "legacy"), undefined);
});

test("failed send stays active and retry completes without duplicating earlier deliveries", async () => {
  const h = await harness();
  await confirmed(h, "one@example.com");
  await confirmed(h, "two@example.com");
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "retry", kind: "one_off" });
  const original = h.sender.send.bind(h.sender);
  let calls = 0;
  h.sender.send = async (message) => {
    if (++calls === 2) throw new Error("SES unavailable");
    await original(message);
  };
  await assert.rejects(send(h, "retry"), /SES unavailable/);
  assert.equal((await h.stores.schedules.get(ORG, "retry"))?.status, "active");
  await send(h, "retry");
  assert.equal(h.sender.sent.length, 2);
  assert.equal((await h.stores.schedules.get(ORG, "retry"))?.status, "completed");
});

test("completion write failure retries after all recipients were already sent", async () => {
  const h = await harness();
  await confirmed(h, "reader@example.com");
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "write-retry", kind: "one_off" });
  const put = h.stores.schedules.put.bind(h.stores.schedules);
  let fail = true;
  h.stores.schedules.put = async (state, opts) => {
    if (state.status === "completed" && fail) { fail = false; throw new Error("write failed"); }
    await put(state, opts);
  };
  await assert.rejects(send(h, "write-retry"), /write failed/);
  await send(h, "write-retry");
  assert.equal(h.sender.sent.length, 1);
  assert.equal((await h.stores.schedules.get(ORG, "write-retry"))?.status, "completed");
});

test("out-of-order slices and duplicate retries complete only after every range", async () => {
  const h = await harness();
  for (let i = 0; i < 3; i++) await confirmed(h, `reader${i}@example.com`);
  const rows = await h.stores.subscriptions.listConfirmed(ORG, LIST);
  const slices = planFanOut(rows.map((r) => r.subscriberId).sort(), 1);
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "sliced", kind: "one_off" });
  const sliceSend = (index: number) => sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG, campaignId: "sliced", listId: LIST, subject: "x", template, slice: slices[index],
  });
  await sliceSend(2);
  await sliceSend(2);
  assert.equal((await h.stores.schedules.get(ORG, "sliced"))?.status, "active");
  await Promise.all([sliceSend(0), sliceSend(1)]);
  assert.equal((await h.stores.schedules.get(ORG, "sliced"))?.status, "completed");
  assert.equal(h.sender.sent.length, 3);
});

test("duplicate worker cannot complete while the original send is in flight", async () => {
  const h = await harness();
  await confirmed(h, "reader@example.com");
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "race", kind: "one_off" });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const original = h.sender.send.bind(h.sender);
  h.sender.send = async (message) => { entered(); await blocked; await original(message); };
  const sending = send(h, "race");
  await started;
  try {
    await assert.rejects(send(h, "race"), /awaiting recorded delivery/);
    assert.equal((await h.stores.schedules.get(ORG, "race"))?.status, "active");
  } finally { release(); }
  await sending;
  assert.equal((await h.stores.schedules.get(ORG, "race"))?.status, "completed");
  assert.equal(h.sender.sent.length, 1);
});

test("stale pause/resume writes lose to completion, even with a fixed clock", async () => {
  const h = await harness();
  const initial = await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "cas", kind: "one_off" });
  await completeScheduleRange(h.stores, h.clock, ORG, "cas");
  await assert.rejects(h.stores.schedules.put({ ...initial, status: "paused" }, { ifRevision: initial.revision }), ConcurrentModificationError);
  assert.equal((await h.stores.schedules.get(ORG, "cas"))?.status, "completed");
});

test("archive during dispatch stays archived; paused in-flight completion clears parked work", async () => {
  for (const action of ["pause", "archive"] as const) {
    const h = await harness();
    await confirmed(h, "reader@example.com");
    await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "operator", kind: "one_off" });
    const original = h.sender.send.bind(h.sender);
    h.sender.send = async (message) => {
      await transitionSchedule(h.stores, h.clock, { orgId: ORG, scheduleId: "operator", action });
      if (action === "pause") await send(h, "operator");
      await original(message);
    };
    await send(h, "operator");
    const state = await h.stores.schedules.get(ORG, "operator");
    assert.equal(state?.status, action === "pause" ? "completed" : "archived");
    assert.equal(state?.deferred, undefined);
  }
});

test("halted send does not complete", async () => {
  const h = await harness();
  await markScheduleActive(h.stores, h.clock, { orgId: ORG, scheduleId: "halted", kind: "one_off" });
  await h.stores.halts.halt(ORG, "halted", h.clock.now().toISOString());
  assert.equal((await send(h, "halted")).halted, true);
  assert.equal((await h.stores.schedules.get(ORG, "halted"))?.status, "active");
});
