/**
 * OpenSearch segment engine: predicate → bool query translation (incl. the
 * engagement-recency predicate the v1 engine rejects), projection shape, and
 * resolve/estimate against a fake OpenSearch client.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Subscriber } from "@addressium/core";
import {
  buildQuery,
  projectSubscriber,
  subscriberToIndexOp,
  indexForOrg,
  docId,
  OpenSearchSegmentEngine,
  type OpenSearchClient,
  type SegmentPredicate,
} from "@addressium/segment";
import { OpenSearchBulkWriter } from "@addressium/adapters-aws";

test("buildQuery: match=all yields must + must_not clauses", () => {
  const predicate: SegmentPredicate = {
    match: "all",
    conditions: [
      { field: "list", op: "in", value: "ledger" },
      { field: "entitlement", op: "eq", value: "paid" },
      { field: "city", op: "neq", value: "Denver" },
      { field: "last_open_at", op: "after", value: "2026-01-01" },
    ],
  };
  const { query } = buildQuery(predicate) as { query: { bool: { must: unknown[]; must_not: unknown[] } } };
  assert.equal(query.bool.must.length, 3); // list, entitlement, last_open_at
  assert.equal(query.bool.must_not.length, 1); // city != Denver
  assert.deepEqual(query.bool.must[2], { range: { last_open_at: { gt: "2026-01-01" } } });
});

test("buildQuery: match=any yields should clauses with negations wrapped", () => {
  const predicate: SegmentPredicate = {
    match: "any",
    conditions: [
      { field: "entitlement", op: "eq", value: "paid" },
      { field: "city", op: "neq", value: "Denver" },
    ],
  };
  const { query } = buildQuery(predicate) as {
    query: { bool: { should: unknown[]; minimum_should_match: number } };
  };
  assert.equal(query.bool.should.length, 2);
  assert.equal(query.bool.minimum_should_match, 1);
  assert.deepEqual(query.bool.should[1], { bool: { must_not: [{ term: { "attr.city": "Denver" } }] } });
});

test("projectSubscriber flattens attributes and carries lists + last_open_at", () => {
  const subscriber: Subscriber = {
    orgId: "summit",
    sub: "s1",
    email: "a@x.com",
    attributes: { city: "Lakeside" },
    status: "active",
    entitlement: "paid",
  };
  const doc = projectSubscriber(subscriber, ["ledger"], "2026-07-01T00:00:00Z");
  assert.equal(doc.attr.city, "Lakeside");
  assert.deepEqual(doc.lists, ["ledger"]);
  assert.equal(doc.last_open_at, "2026-07-01T00:00:00Z");
});

test("subscriberToIndexOp maps INSERT/MODIFY to index and REMOVE to delete", () => {
  const subscriber: Subscriber = {
    orgId: "summit",
    sub: "s1",
    email: "a@x.com",
    attributes: {},
    status: "active",
    entitlement: "free",
  };
  const idx = subscriberToIndexOp("INSERT", subscriber, ["ledger"]);
  assert.equal(idx.type, "index");
  assert.equal(idx.index, indexForOrg("summit"));
  assert.equal(idx.id, docId("summit", "s1"));

  const del = subscriberToIndexOp("REMOVE", subscriber);
  assert.equal(del.type, "delete");
  assert.equal(del.id, docId("summit", "s1"));
});

test("OpenSearchBulkWriter.bulkBody emits NDJSON action + doc lines", () => {
  const subscriber: Subscriber = {
    orgId: "summit",
    sub: "s1",
    email: "a@x.com",
    attributes: {},
    status: "active",
    entitlement: "free",
  };
  const body = OpenSearchBulkWriter.bulkBody([
    subscriberToIndexOp("INSERT", subscriber, ["ledger"]),
    subscriberToIndexOp("REMOVE", subscriber),
  ]);
  const lines = body.trimEnd().split("\n");
  assert.equal(lines.length, 3); // index action + doc, delete action
  assert.deepEqual(JSON.parse(lines[0]!), { index: { _index: indexForOrg("summit"), _id: docId("summit", "s1") } });
  assert.deepEqual(JSON.parse(lines[2]!), { delete: { _index: indexForOrg("summit"), _id: docId("summit", "s1") } });
});

test("engine resolve/estimate call the client with the org index", async () => {
  const calls: string[] = [];
  const client: OpenSearchClient = {
    async search(index) {
      calls.push(`search:${index}`);
      return { hits: { hits: [{ _id: "summit:s1" }, { _id: "summit:s2" }] } };
    },
    async count(index) {
      calls.push(`count:${index}`);
      return { count: 2 };
    },
  };
  const engine = new OpenSearchSegmentEngine(client);
  const predicate: SegmentPredicate = { match: "all", conditions: [{ field: "entitlement", op: "eq", value: "paid" }] };

  const ids: string[] = [];
  for await (const id of engine.resolve("summit", predicate)) ids.push(id);
  assert.deepEqual(ids, ["s1", "s2"]); // orgId prefix stripped from _id

  assert.equal(await engine.estimate("summit", predicate), 2);
  assert.deepEqual(calls, [`search:${indexForOrg("summit")}`, `count:${indexForOrg("summit")}`]);
});
