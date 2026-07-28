/**
 * Unvalidated ids and unbounded inputs (#196).
 *
 * The DynamoDB key design was never the problem — composite partitions have
 * disjoint sort-key namespaces and no cross-tenant item collision was
 * constructible. The damage was in the namespaces the ids LEAK into, which are
 * flat and are not ours: EventBridge Scheduler names, the send-claim key, S3
 * keys, Secrets Manager names, KMS aliases, the magic-link `issuer`.
 *
 * These tests pin the charset and the two derived keys together, because each is
 * only safe given the other: `.` and `#` are usable as unambiguous separators
 * exactly because `idSchema` forbids them. Widening the charset without
 * revisiting the separators puts the collisions straight back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { schemas } from "@addressium/core";
import {
  memStores,
  provisionOrganization,
  scheduleName,
  sendClaimKey,
  type ProvisioningProviders,
} from "@addressium/domain";

const { idSchema, signupManySchema, signupSchema, scheduleCampaignSchema } = schemas;

test("idSchema accepts the ids an operator actually uses", () => {
  for (const ok of ["acme", "the-ledger", "ledger_weekly", "c1", "2026-review", "a".repeat(64)]) {
    assert.equal(idSchema.safeParse(ok).success, true, ok);
  }
});

test("idSchema rejects every separator the derived keys depend on", () => {
  // Each of these previously reached a namespace that is not ours.
  const bad: [string, string][] = [
    ["promo#0", "`#` is the send-claim separator"],
    ["a.b", "`.` is the schedule-name separator"],
    ["a/b", "`/` is an S3 key separator"],
    ["a:b", "`:` is an ARN separator"],
    ["a b", "whitespace"],
    ["Acme", "uppercase — two ids that differ only in case are one S3 prefix"],
    ["-lead", "a leading dash reads as a CLI flag in a runbook"],
    ["", "empty"],
    ["a".repeat(65), "past the EventBridge Scheduler name budget"],
  ];
  for (const [value, why] of bad) {
    assert.equal(idSchema.safeParse(value).success, false, `${JSON.stringify(value)}: ${why}`);
  }
});

test("two orgs cannot collide on a schedule name", () => {
  // The exact reported case. `-` is legal INSIDE an id, so concatenating with
  // `-` was ambiguous: org `acme` + campaign `x-1` and org `acme-x` + campaign
  // `1` both produced `camp-acme-x-1`. CreateSchedule is not an upsert, so the
  // second tenant got a ConflictException — one org denying scheduling to
  // another, by accident or on purpose.
  assert.notEqual(scheduleName("camp", "acme", "x-1"), scheduleName("camp", "acme-x", "1"));
  assert.notEqual(scheduleName("series", "acme", "x-1"), scheduleName("series", "acme-x", "1"));
  // And the old scheme really was ambiguous — the reason this test exists.
  assert.equal(`camp-${"acme"}-${"x-1"}`, `camp-${"acme-x"}-${"1"}`);
});

test("a schedule name stays readable, and distinct per kind", () => {
  assert.equal(scheduleName("camp", "acme", "spring"), "camp.acme.spring");
  // A one-off and a recurring series for the same campaign are two schedules.
  assert.notEqual(scheduleName("camp", "acme", "spring"), scheduleName("series", "acme", "spring"));
});

test("an oversized pair hashes instead of truncating, and still fits", () => {
  // Truncating the readable form would put the collision back at the cut point,
  // which is the whole failure being fixed.
  const org = "o".repeat(64);
  const a = scheduleName("camp", org, "c".repeat(64));
  const b = scheduleName("camp", org, "c".repeat(63) + "d");
  assert.ok(a.length <= 64 && b.length <= 64, "EventBridge Scheduler caps names at 64");
  assert.notEqual(a, b, "two long pairs that share a 64-char prefix must not collide");
  // The digest covers the boundary between the two ids, not their concatenation.
  assert.notEqual(scheduleName("camp", "a".repeat(64), "b" + "c".repeat(63)),
                  scheduleName("camp", "a".repeat(63) + "b", "c".repeat(63)));
});

test("every valid id pair produces a legal EventBridge Scheduler name", () => {
  const pattern = /^[0-9a-zA-Z._-]{1,64}$/;
  for (const [org, camp] of [
    ["a", "b"],
    ["acme", "spring-2026"],
    ["o".repeat(64), "c".repeat(64)],
    ["org_with_underscores", "camp_1"],
  ]) {
    for (const kind of ["camp", "series"] as const) {
      const name = scheduleName(kind, org!, camp!);
      assert.match(name, pattern, `${kind}/${org}/${camp} -> ${name}`);
    }
  }
});

test("a campaign named like a claim key cannot steal another campaign's claim", () => {
  // `promo#0` + subscriber `s` vs `promo` + subscriber `0#s`. The loser was
  // silently skipped as "already sent": a subscriber who never receives the
  // campaign, with nothing in any log to explain it.
  assert.equal(sendClaimKey("promo#0", "s"), sendClaimKey("promo", "0#s"));
  // Which is exactly why the charset has to forbid `#` — that is the fix.
  assert.equal(idSchema.safeParse("promo#0").success, false);
  assert.equal(scheduleCampaignSchema.shape.campaignId.safeParse("promo#0").success, false);
});

test("distinct valid pairs give distinct claim keys", () => {
  const keys = new Set([
    sendClaimKey("promo", "s1"),
    sendClaimKey("promo", "s2"),
    sendClaimKey("promo-2", "s1"),
    sendClaimKey("promo_2", "s1"),
  ]);
  assert.equal(keys.size, 4);
});

test("oversized batch signup is rejected", () => {
  // Unauthenticated, and the handler walks the ids sequentially — 50,000 ids was
  // 50,000 round-trips from one anonymous request.
  const base = { orgId: "acme", email: "a@x.com" };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `list-${i}`);
  assert.equal(signupManySchema.safeParse({ ...base, listIds: ids(50) }).success, true);
  assert.equal(signupManySchema.safeParse({ ...base, listIds: ids(51) }).success, false);
  assert.equal(signupManySchema.safeParse({ ...base, listIds: ids(50_000) }).success, false);
  // Still requires at least one.
  assert.equal(signupManySchema.safeParse({ ...base, listIds: [] }).success, false);
});

test("attributes are bounded in count and value length", () => {
  // An anonymous caller could write a subscriber item up to DynamoDB's 400 KB
  // ceiling, and every later read of that subscriber pays for it.
  const base = { orgId: "acme", email: "a@x.com", listId: "ledger" };
  const attrs = (n: number, len = 1) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v".repeat(len)]));

  assert.equal(signupSchema.safeParse({ ...base, attributes: attrs(32) }).success, true);
  assert.equal(signupSchema.safeParse({ ...base, attributes: attrs(33) }).success, false);
  assert.equal(signupSchema.safeParse({ ...base, attributes: attrs(1, 1024) }).success, true);
  assert.equal(signupSchema.safeParse({ ...base, attributes: attrs(1, 1025) }).success, false);
  assert.equal(
    signupSchema.safeParse({ ...base, attributes: { ["k".repeat(65)]: "v" } }).success,
    false,
    "an unbounded KEY is the same amplification as an unbounded value",
  );
});

function fakeProviders(): ProvisioningProviders {
  return {
    linkSubscriberPool: async () => ({ poolId: "pool-123" }),
    createSigningKey: async () => ({ kmsKeyArn: "arn:aws:kms:...:key/abc", kid: "abc" }),
    ensureSesDomainIdentity: async () => ({
      configSet: "cs",
      dkimTokens: ["t1"],
      verificationStatus: "pending",
    }),
  };
}

const orgInput: schemas.CreateOrgInput = {
  name: "Northwind Times",
  primaryDomain: "northwindtimes.example",
  siteDomain: "northwindtimes.example",
  region: "us-east-1",
  defaultTimezone: "UTC",
  magicLinks: false,
  dedicatedIp: false,
  suppressionScope: "hybrid",
  environment: "prod",
};

test("provisioning rejects a non-slug orgId override", async () => {
  // The handler read `event.orgId` off the RAW event, so `slugifyOrgId` was
  // bypassed and this string went on to be interpolated into S3 keys, a Secrets
  // Manager name, a KMS alias, an OpenSearch index and the magic-link `issuer`.
  for (const bad of ["../../etc", "Org Name", "a/b", "a#b", "o".repeat(65)]) {
    await assert.rejects(
      () => provisionOrganization(memStores(), fakeProviders(), orgInput, { orgId: bad }),
      `accepted ${JSON.stringify(bad)}`,
    );
  }
});

test("provisioning still accepts a legitimate override and the derived slug", async () => {
  // A validator that blocks the normal path is not a fix.
  const a = await provisionOrganization(memStores(), fakeProviders(), orgInput, { orgId: "nwt" });
  assert.equal(a.org.orgId, "nwt");
  const b = await provisionOrganization(memStores(), fakeProviders(), orgInput);
  assert.equal(b.org.orgId, "northwind-times");
});

test("a display name that slugs past the id limit fails loudly", async () => {
  // Truncating would hand org B the org A record on the idempotency check —
  // silent cross-tenant aliasing, which is worse than a 400.
  await assert.rejects(
    () => provisionOrganization(memStores(), fakeProviders(), { ...orgInput, name: "N".repeat(80) }),
    /64|too_big|small/i,
  );
});
