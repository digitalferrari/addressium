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
