/**
 * Compose + schedule payload validation (§4.6): the schedule endpoint now parses
 * `scheduleCampaignSchema` instead of trusting the body, so the compose UI can't
 * post a malformed campaign (missing list/subject, empty body, bad link URL, or
 * an unknown `when`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { schemas } from "@addressium/core";

const good = {
  orgId: "summit",
  campaignId: "daily-2026-07-21",
  listId: "ledger",
  subject: "Morning briefing",
  template: {
    blocks: [
      { kind: "text", html: "<p>Hello {{first_name}}</p>" },
      { kind: "editorial", label: "Read more", url: "https://summitdaily.example/a" },
    ],
  },
  when: { type: "now" },
};

test("valid compose payloads parse for now / at / recurring", () => {
  assert.equal(schemas.scheduleCampaignSchema.safeParse(good).success, true);
  assert.equal(
    schemas.scheduleCampaignSchema.safeParse({ ...good, when: { type: "at", at: "2026-07-25T13:00:00Z" } }).success,
    true,
  );
  assert.equal(
    schemas.scheduleCampaignSchema.safeParse({
      ...good,
      when: { type: "recurring", cron: "cron(0 13 * * ? *)", timezone: "America/Denver" },
    }).success,
    true,
  );
});

test("empty body, missing subject/list, and bad editorial URL are rejected", () => {
  assert.equal(schemas.scheduleCampaignSchema.safeParse({ ...good, template: { blocks: [] } }).success, false);
  assert.equal(schemas.scheduleCampaignSchema.safeParse({ ...good, subject: "" }).success, false);
  assert.equal(schemas.scheduleCampaignSchema.safeParse({ ...good, listId: "" }).success, false);
  assert.equal(
    schemas.scheduleCampaignSchema.safeParse({
      ...good,
      template: { blocks: [{ kind: "editorial", label: "x", url: "not-a-url" }] },
    }).success,
    false,
  );
});

test("an unknown or malformed `when` is rejected", () => {
  assert.equal(schemas.scheduleCampaignSchema.safeParse({ ...good, when: { type: "someday" } }).success, false);
  assert.equal(schemas.scheduleCampaignSchema.safeParse({ ...good, when: { type: "at" } }).success, false);
  assert.equal(schemas.scheduleCampaignSchema.safeParse({ ...good, when: { type: "recurring" } }).success, false);
});
