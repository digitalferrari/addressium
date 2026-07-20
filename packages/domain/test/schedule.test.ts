/**
 * Scheduling ports: enqueue for "send now", one-off + recurring schedules, cancel.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemScheduler, MemSendQueue, type SendDescriptor } from "@addressium/domain";

const descriptor: SendDescriptor = {
  orgId: "summit",
  campaignId: "c1",
  listId: "ledger",
  subject: "x",
  template: { blocks: [{ kind: "text", html: "hi" }] },
};

test("send-now enqueues the descriptor", async () => {
  const q = new MemSendQueue();
  await q.enqueue(descriptor);
  assert.equal(q.enqueued.length, 1);
  assert.equal(q.enqueued[0]?.campaignId, "c1");
});

test("one-off and recurring schedules are recorded and cancellable", async () => {
  const s = new MemScheduler();
  await s.scheduleOneOff({ name: "c1", at: new Date("2026-07-25T12:00:00Z"), descriptor });
  await s.scheduleRecurring({
    name: "series-ledger",
    cron: "cron(0 6 * * ? *)",
    timezone: "America/Denver",
    payload: { orgId: "summit", seriesId: "ledger" },
  });
  assert.equal(s.oneOff.has("c1"), true);
  assert.equal(s.recurring.get("series-ledger")?.timezone, "America/Denver");

  await s.cancel("c1");
  assert.equal(s.oneOff.has("c1"), false);
});
