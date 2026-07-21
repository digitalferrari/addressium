/**
 * Analytics export projection (§4.23): flatten an engagement event to a columnar
 * row (with a UTC partition day), and extract an event from a raw DynamoDB stream
 * image — dropping non-event items, incomplete images, and never leaking tokens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { EngagementEvent } from "@addressium/core";
import { eventFromImage, eventPartitionDate, toEventAnalyticsRow } from "@addressium/domain";

const click: EngagementEvent = {
  orgId: "summit", campaignId: "ledger-jul20", subscriberId: "s1",
  type: "click", linkId: "L3", at: "2026-07-20T14:30:00.000Z",
};

test("eventPartitionDate is the UTC calendar day", () => {
  assert.equal(eventPartitionDate("2026-07-20T14:30:00.000Z"), "2026-07-20");
  assert.equal(eventPartitionDate("2026-01-01T00:00:00Z"), "2026-01-01");
});

test("toEventAnalyticsRow flattens and derives the partition", () => {
  assert.deepEqual(toEventAnalyticsRow(click), {
    org_id: "summit", campaign_id: "ledger-jul20", subscriber_id: "s1",
    event_type: "click", link_id: "L3", at: "2026-07-20T14:30:00.000Z", event_date: "2026-07-20",
  });
});

test("a non-click event has a null link_id", () => {
  const row = toEventAnalyticsRow({ ...click, type: "open", linkId: undefined });
  assert.equal(row.link_id, null);
  assert.equal(row.event_type, "open");
});

// ---- extraction from a marshalled DynamoDB stream image ----

const image = (over: Record<string, unknown> = {}) => ({
  pk: { S: "ORG#summit#CAMPAIGN#ledger-jul20" },
  sk: { S: "EVENT#2026-07-20T14:30:00.000Z#uuid" },
  data: {
    M: {
      orgId: { S: "summit" },
      campaignId: { S: "ledger-jul20" },
      subscriberId: { S: "s1" },
      type: { S: "click" },
      linkId: { S: "L3" },
      at: { S: "2026-07-20T14:30:00.000Z" },
      ...over,
    },
  },
});

test("eventFromImage reconstructs the event from a NewImage", () => {
  assert.deepEqual(eventFromImage(image()), click);
});

test("eventFromImage drops non-event items (sk not EVENT#…)", () => {
  const subscriberItem = { sk: { S: "SUBSCRIBER#s1" }, data: { M: { orgId: { S: "summit" } } } };
  assert.equal(eventFromImage(subscriberItem), null);
});

test("eventFromImage drops an incomplete image", () => {
  assert.equal(eventFromImage(image({ at: undefined })), null); // missing timestamp
  assert.equal(eventFromImage(undefined), null);
});

test("eventFromImage omits linkId when absent (open/sent)", () => {
  const ev = eventFromImage(image({ type: { S: "open" }, linkId: undefined }));
  assert.equal(ev?.linkId, undefined);
  assert.equal(ev?.type, "open");
});
