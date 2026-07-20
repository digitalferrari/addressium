/**
 * OrganizationStore round-trip and the one-off scheduling floor (cancel window).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Organization } from "@addressium/core";
import { MemOrganizations, effectiveOneOffTime, MIN_ONEOFF_LEAD_MS } from "@addressium/domain";

const org: Organization = {
  orgId: "summit",
  name: "Summit Daily",
  domains: ["summitdaily.com"],
  subscriberPoolId: "us-east-1_Smt",
  magicLink: {
    kmsKeyArn: "arn:aws:kms:...:key/1",
    kid: "k1",
    issuer: "https://addressium/summit",
    audience: "summitdaily.com",
  },
  sesConfigSet: "summit-cs",
  ipMode: "shared",
  suppressionScope: "hybrid",
  defaultTimezone: "America/Denver",
  setupComplete: true,
};

test("organization store round-trips and lists", async () => {
  const store = new MemOrganizations();
  assert.equal(await store.get("summit"), undefined);
  await store.put(org);
  assert.equal((await store.get("summit"))?.defaultTimezone, "America/Denver");
  assert.equal((await store.list()).length, 1);
});

test("one-off floor: 'now' lands >= 5 minutes out; a later request is honored", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  const nowSend = effectiveOneOffTime(now); // "send now"
  assert.equal(nowSend.getTime(), now.getTime() + MIN_ONEOFF_LEAD_MS);

  const soon = effectiveOneOffTime(now, new Date("2026-07-20T12:02:00.000Z")); // 2 min < floor
  assert.equal(soon.getTime(), now.getTime() + MIN_ONEOFF_LEAD_MS);

  const later = new Date("2026-07-20T18:00:00.000Z");
  assert.equal(effectiveOneOffTime(now, later).getTime(), later.getTime()); // honored
});
