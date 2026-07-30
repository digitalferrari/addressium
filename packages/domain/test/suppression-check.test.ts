/**
 * Looking up one address against both suppression records (#247) — the console
 * equivalent of `aws sesv2 get-suppressed-destination`, plus what our own send
 * path actually gates on (`mayMail` reads `entriesFor`, never SES directly).
 *
 * The load-bearing distinction throughout: `live: null` (SES was asked and said
 * clear) is not the same answer as `live: undefined` (SES was not, or could not
 * be, asked). Collapsing them would tell an operator an address is clear when
 * the honest answer is "nobody knows."
 */
import assert from "node:assert/strict";
import test from "node:test";
import { checkSuppression, memStores, SystemClock } from "@addressium/domain";
import type { SuppressedDestination, SuppressionChecker } from "@addressium/domain";

const ORG = "summit";
const clock = new SystemClock();

const checkerOf = (
  answer: SuppressedDestination | undefined | (() => Promise<SuppressedDestination | undefined>),
): SuppressionChecker => ({
  get: async () => (typeof answer === "function" ? answer() : answer),
  put: async () => {},
});

test("with no checker, only the local answer comes back — live is undefined, not null", async () => {
  const stores = memStores();
  await stores.suppression.add({
    orgId: ORG,
    email: "hard@example.com",
    source: "bounce",
    scope: "global",
    addedAt: clock.now().toISOString(),
  });
  const res = await checkSuppression(stores, undefined, ORG, "hard@example.com");
  assert.equal(res.local.length, 1);
  assert.equal(res.live, undefined, "undefined means unasked, not confirmed clear");
  assert.equal(res.liveError, undefined);
});

test("SES confirms clear: live is null, distinct from undefined", async () => {
  const stores = memStores();
  const res = await checkSuppression(stores, checkerOf(undefined), ORG, "clean@example.com");
  assert.equal(res.local.length, 0);
  assert.equal(res.live, null, "SES was asked and said not suppressed — null, not undefined");
});

test("SES confirms suppressed: the live entry comes through, local can be empty", async () => {
  const stores = memStores();
  // The scenario this feature exists for: SES knows and we do not yet — a
  // different sender in the account, or an operator using the SES console
  // directly, suppressed this address outside our own pipeline.
  const res = await checkSuppression(
    stores,
    checkerOf({ email: "ghost@example.com", reason: "COMPLAINT", at: "2024-01-01T00:00:00.000Z" }),
    ORG,
    "ghost@example.com",
  );
  assert.equal(res.local.length, 0, "our own store never heard about it");
  assert.deepEqual(res.live, { email: "ghost@example.com", reason: "COMPLAINT", at: "2024-01-01T00:00:00.000Z" });
});

test("a failed live check degrades to liveError, and still returns the local answer", async () => {
  const stores = memStores();
  await stores.suppression.add({
    orgId: ORG,
    email: "local-only@example.com",
    source: "manual",
    scope: "org",
    addedAt: clock.now().toISOString(),
  });
  const throwing: SuppressionChecker = {
    get: async () => {
      throw new Error("ThrottlingException: rate exceeded");
    },
    put: async () => {},
  };
  const res = await checkSuppression(stores, throwing, ORG, "local-only@example.com");
  // A throttled SES call must not take down a subscriber-detail page — the
  // local half is still real and still answered.
  assert.equal(res.local.length, 1);
  assert.equal(res.live, undefined);
  assert.match(res.liveError ?? "", /ThrottlingException/);
});

test("both a local org entry and a local global entry are returned together", async () => {
  const stores = memStores();
  await stores.suppression.add({
    orgId: ORG,
    email: "double@example.com",
    source: "manual",
    scope: "org",
    addedAt: clock.now().toISOString(),
  });
  await stores.suppression.add({
    orgId: ORG,
    email: "double@example.com",
    source: "bounce",
    scope: "global",
    addedAt: clock.now().toISOString(),
  });
  const res = await checkSuppression(stores, undefined, ORG, "double@example.com");
  assert.equal(res.local.length, 2);
  assert.deepEqual(
    res.local.map((e) => e.scope).sort(),
    ["global", "org"],
  );
});

test("the email is lower-cased the same way the store does it", async () => {
  // Case only — matching every store implementation's own normalization
  // (`email.toLowerCase()`, no trim anywhere in this codebase). Inventing a
  // second normalization rule here would just be a second place to disagree.
  const stores = memStores();
  await stores.suppression.add({
    orgId: ORG,
    email: "mixed@example.com",
    source: "manual",
    scope: "org",
    addedAt: clock.now().toISOString(),
  });
  const res = await checkSuppression(stores, undefined, ORG, "MIXED@Example.COM");
  assert.equal(res.email, "mixed@example.com");
  assert.equal(res.local.length, 1, "a differently-cased lookup must still find the entry");
});
