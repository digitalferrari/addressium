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

import {
  buildEventBridgeCron,
  parseEventBridgeCron,
  describeSchedule,
  getNextRuns,
} from "@addressium/domain";

test("hourly cron building, parsing and describing", () => {
  const cronStr = buildEventBridgeCron({ frequency: "hourly", timeOfDay: "12:15" });
  assert.equal(cronStr, "cron(15 * * * ? *)");

  const parsed = parseEventBridgeCron("cron(15 * * * ? *)");
  assert.deepEqual(parsed, { frequency: "hourly", timeOfDay: "00:15" });

  const desc = describeSchedule("cron(15 * * * ? *)", "America/Denver");
  assert.equal(desc, "Every hour at minute 15 (America/Denver)");
});

test("getNextRuns computes accurate future occurrences", () => {
  // 1. Hourly
  const hourlyRuns = getNextRuns({ frequency: "hourly", timeOfDay: "00:30" }, undefined, 3);
  assert.equal(hourlyRuns.length, 3);
  assert.equal(hourlyRuns[0]?.getMinutes(), 30);
  assert.equal(hourlyRuns[1]?.getMinutes(), 30);
  assert.equal(hourlyRuns[2]?.getMinutes(), 30);
  const diff1 = hourlyRuns[1]!.getTime() - hourlyRuns[0]!.getTime();
  const diff2 = hourlyRuns[2]!.getTime() - hourlyRuns[1]!.getTime();
  assert.equal(diff1, 60 * 60 * 1000); // exactly 1 hour
  assert.equal(diff2, 60 * 60 * 1000);

  // 2. Daily
  const dailyRuns = getNextRuns({ frequency: "daily", timeOfDay: "13:00" }, "America/Denver", 3);
  assert.equal(dailyRuns.length, 3);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  assert.equal(formatter.format(dailyRuns[0]!), "13:00");
  assert.equal(formatter.format(dailyRuns[1]!), "13:00");
  assert.equal(formatter.format(dailyRuns[2]!), "13:00");
  const dayDiff = dailyRuns[1]!.getTime() - dailyRuns[0]!.getTime();
  // Roughly 24 hours (could be 23 or 25 on DST transition, but always 24h around neutral dates)
  assert.ok(dayDiff >= 23 * 60 * 60 * 1000 && dayDiff <= 25 * 60 * 60 * 1000);
});
