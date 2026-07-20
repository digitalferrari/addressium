/**
 * v1 segment engine: list base set + entitlement/attribute filters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { memStores } from "@addressium/domain";
import { GsiSegmentEngine } from "@addressium/segment";
import type { List, Subscriber, Subscription } from "@addressium/core";

const ORG = "summit";
const LIST = "ledger";

async function seed() {
  const stores = memStores();
  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "l@x.com",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "a",
  };
  await stores.lists.put(list);

  const people: Array<[string, "free" | "paid", string]> = [
    ["a", "paid", "Denver"],
    ["b", "free", "Denver"],
    ["c", "paid", "Vail"],
  ];
  for (const [id, ent, city] of people) {
    const sub: Subscriber = {
      orgId: ORG,
      sub: id,
      email: `${id}@x.com`,
      attributes: { city },
      status: "active",
      entitlement: ent,
    };
    await stores.subscribers.put(sub);
    const s: Subscription = { orgId: ORG, subscriberId: id, listId: LIST, status: "confirmed", updatedAt: "" };
    await stores.subscriptions.put(s);
  }
  return stores;
}

async function ids(engine: GsiSegmentEngine, predicate: Parameters<GsiSegmentEngine["estimate"]>[1]) {
  const out: string[] = [];
  for await (const id of engine.resolve(ORG, predicate)) out.push(id);
  return out.sort();
}

test("list base set with entitlement + attribute filters", async () => {
  const engine = new GsiSegmentEngine(await seed());

  assert.deepEqual(
    await ids(engine, { match: "all", conditions: [{ field: "list", op: "in", value: LIST }] }),
    ["a", "b", "c"],
  );

  assert.deepEqual(
    await ids(engine, {
      match: "all",
      conditions: [
        { field: "list", op: "in", value: LIST },
        { field: "entitlement", op: "eq", value: "paid" },
      ],
    }),
    ["a", "c"],
  );

  assert.deepEqual(
    await ids(engine, {
      match: "all",
      conditions: [
        { field: "list", op: "in", value: LIST },
        { field: "entitlement", op: "eq", value: "paid" },
        { field: "city", op: "eq", value: "Denver" },
      ],
    }),
    ["a"],
  );

  assert.equal(
    await engine.estimate(ORG, {
      match: "all",
      conditions: [{ field: "list", op: "in", value: LIST }],
    }),
    3,
  );
});

test("requires a list base condition", async () => {
  const engine = new GsiSegmentEngine(await seed());
  await assert.rejects(async () => {
    for await (const _ of engine.resolve(ORG, { match: "all", conditions: [{ field: "entitlement", op: "eq", value: "paid" }] })) {
      // no-op
    }
  });
});
