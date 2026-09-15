import test from "node:test";
import assert from "node:assert/strict";
import { aggregateTrends } from "@addressium/svc-reporting";
import type { EngagementEvent } from "@addressium/core";

const event = (type: EngagementEvent["type"], at: string, subscriberId: string, campaignId = "c1"): EngagementEvent => ({
  orgId: "acme", campaignId, subscriberId, type, at,
});

test("analytics trends aggregate real event dates and deduplicate daily opens/clicks", () => {
  const points = aggregateTrends([
    event("sent", "2026-09-14T10:00:00.000Z", "s1"),
    event("delivered", "2026-09-14T10:01:00.000Z", "s1"),
    event("open", "2026-09-14T11:00:00.000Z", "s1"),
    event("open", "2026-09-14T11:02:00.000Z", "s1"),
    event("click", "2026-09-14T12:00:00.000Z", "s1"),
    event("click", "2026-09-14T12:02:00.000Z", "s1"),
    event("bounce", "2026-09-15T12:00:00.000Z", "s2"),
  ], "2026-09-14", "2026-09-15");

  assert.deepEqual(points.map(({ date, sent, delivered, opens, clicks, bounces, openRate, clickRate }) => ({
    date, sent, delivered, opens, clicks, bounces, openRate, clickRate,
  })), [
    { date: "2026-09-14", sent: 1, delivered: 1, opens: 1, clicks: 1, bounces: 0, openRate: 1, clickRate: 1 },
    { date: "2026-09-15", sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 1, openRate: 0, clickRate: 0 },
  ]);
});
