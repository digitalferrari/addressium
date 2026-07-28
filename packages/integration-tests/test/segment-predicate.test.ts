/**
 * Segment predicate validation (#195).
 *
 * The predicate was `z.unknown()`, interpreted later as
 * `predicate.match === "all" ? every : some`. A missing or misspelled `match`
 * fell through to `some`, and combined with `case "list": return true`, every
 * subscriber in the base set matched.
 *
 * The scenario that makes this High severity: an operator saves a segment
 * intended as "paid VIPs" with a typo'd `match`, sees a plausible preview count,
 * and the campaign goes to the ENTIRE list — including the people the segment
 * existed to exclude. Nothing in that sequence looks wrong until the mail lands.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { schemas } from "@addressium/core";
import { GsiSegmentEngine, type SegmentPredicate } from "@addressium/segment";
import { memStores } from "@addressium/domain";
import type { Subscriber } from "@addressium/core";

const ORG = "summit";
const LIST = "ledger";
const parse = (predicate: unknown) =>
  schemas.saveSegmentSchema.safeParse({ orgId: ORG, segmentId: "s", name: "n", predicate });

test("a predicate with no `match` is rejected at save", () => {
  const r = parse({ conditions: [{ field: "entitlement", op: "eq", value: "paid" }] });
  assert.equal(r.success, false, "this is the typo that mailed the whole list");
});

test("a misspelled `match` is rejected at save", () => {
  for (const match of ["ALL", "any ", "evey", "", null, 1]) {
    assert.equal(parse({ match, conditions: [{ field: "x", op: "exists" }] }).success, false, String(match));
  }
  assert.equal(parse({ match: "all", conditions: [{ field: "x", op: "exists" }] }).success, true);
});

test("prototype-chain field names cannot be saved", () => {
  // `attributes["constructor"]` returns Object, which is !== undefined, so
  // `exists` matched every subscriber alive.
  for (const field of ["__proto__", "constructor", "prototype"]) {
    assert.equal(parse({ match: "all", conditions: [{ field, op: "exists" }] }).success, false, field);
  }
});

test("a condition list is bounded and non-empty", () => {
  assert.equal(parse({ match: "all", conditions: [] }).success, false, "empty matches everyone");
  const many = Array.from({ length: 51 }, () => ({ field: "x", op: "exists" as const }));
  assert.equal(parse({ match: "all", conditions: many }).success, false, "unbounded is an amplification vector");
});

test("every operator except `exists` requires a value", () => {
  assert.equal(parse({ match: "all", conditions: [{ field: "x", op: "eq" }] }).success, false);
  assert.equal(parse({ match: "all", conditions: [{ field: "x", op: "exists" }] }).success, true);
});

/** A subscriber with one real attribute, for the engine-level checks. */
async function seeded() {
  const stores = memStores();
  const sub: Subscriber = {
    orgId: ORG,
    sub: "s1",
    email: "a@x.com",
    attributes: { city: "Frisco" },
    status: "active",
    entitlement: "free",
  };
  await stores.subscribers.put(sub);
  await stores.subscriptions.put({
    orgId: ORG,
    subscriberId: "s1",
    listId: LIST,
    status: "confirmed",
    updatedAt: "t",
  });
  return stores;
}

test("`constructor` exists matches NOBODY at the engine, not everybody", async () => {
  // Second line of defence: a predicate stored before the schema existed, or any
  // caller that bypasses the API, must still not match the world.
  const stores = await seeded();
  const engine = new GsiSegmentEngine(stores);
  const n = await engine.estimate(ORG, {
    match: "all",
    conditions: [
      { field: "list", op: "in", value: LIST },
      { field: "constructor", op: "exists" },
    ],
  });
  assert.equal(n, 0, "prototype-chain access must not match a real subscriber");
});

test("a real attribute still matches", async () => {
  // The guard must not be so broad that segments stop working.
  const stores = await seeded();
  const engine = new GsiSegmentEngine(stores);
  assert.equal(
    await engine.estimate(ORG, {
      match: "all",
      conditions: [
        { field: "list", op: "in", value: LIST },
        { field: "city", op: "eq", value: "Frisco" },
      ],
    }),
    1,
  );
});

test("an invalid `match` throws at the engine rather than silently widening", async () => {
  // It used to fall through to `some`. Too few recipients is a visible mistake;
  // too many is an unrecallable one.
  const stores = await seeded();
  const engine = new GsiSegmentEngine(stores);
  await assert.rejects(
    () =>
      engine.estimate(ORG, {
        match: "evey" as unknown as "all",
        conditions: [{ field: "list", op: "in", value: LIST }],
      }),
    /invalid `match`/,
  );
});

test("an absent attribute is `neq` to any value, and never `eq`", async () => {
  const stores = await seeded();
  const engine = new GsiSegmentEngine(stores);
  const cond = (op: "eq" | "neq"): SegmentPredicate => ({
    match: "all",
    conditions: [
      { field: "list", op: "in", value: LIST },
      { field: "nickname", op, value: "Ace" },
    ],
  });
  assert.equal(await engine.estimate(ORG, cond("eq")), 0);
  assert.equal(await engine.estimate(ORG, cond("neq")), 1);
});
