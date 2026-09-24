/**
 * The gsi4 window query, against a real DynamoDB API (#320).
 *
 * `memStores` filters an array, which cannot prove any of the things that
 * actually matter here: that the month shard key is right, that `BETWEEN` on
 * the sort key bounds the window, or that a 30-day span crossing a month
 * boundary reads BOTH shards. Those are index semantics, so they need dynalite.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoStores } from "@addressium/adapters-aws";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-events-window";
const ORG = "acme";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let stores: DynamoStores;

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const throughput = { ReadCapacityUnits: 1, WriteCapacityUnits: 1 };
  const gsi = (n: string) => ({
    IndexName: n,
    KeySchema: [
      { AttributeName: `${n}pk`, KeyType: "HASH" as const },
      { AttributeName: `${n}sk`, KeyType: "RANGE" as const },
    ],
    Projection: { ProjectionType: "ALL" as const },
    ProvisionedThroughput: throughput,
  });
  const client = new DynamoDBClient({
    endpoint, region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  await client.send(new CreateTableCommand({
    TableName: TABLE, BillingMode: "PROVISIONED", ProvisionedThroughput: throughput,
    AttributeDefinitions: ["pk","sk","gsi1pk","gsi1sk","gsi2pk","gsi2sk","gsi3pk","gsi3sk","gsi4pk","gsi4sk"]
      .map((AttributeName) => ({ AttributeName, AttributeType: "S" as const })),
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" as const }, { AttributeName: "sk", KeyType: "RANGE" as const }],
    GlobalSecondaryIndexes: [gsi("gsi1"), gsi("gsi2"), gsi("gsi3"), gsi("gsi4")],
  }));
  // Dynalite implements no TransactWriteItems, so counters degrade to puts.
  stores = new DynamoStores(TABLE, client, { nonTransactionalCountersForTests: true });
});

after(() => server?.close());

const add = (campaignId: string, at: string, sub = "s1") =>
  stores.events.append({ orgId: ORG, subscriberId: sub, campaignId, type: "sent", at });

test("a window inside one month reads that month's shard", async () => {
  await add("c-feb", "2026-02-20T10:00:00.000Z");
  await add("c-mar", "2026-03-10T10:00:00.000Z");
  await add("c-apr", "2026-04-02T10:00:00.000Z");

  const got = await stores.events.betweenDates!(ORG, "2026-03-01", "2026-03-31");
  assert.deepEqual(got.map((e) => e.campaignId), ["c-mar"]);
});

test("a window CROSSING a month boundary reads both shards", async () => {
  // The case the month sharding exists for, and the one a single-partition
  // design would have got right by accident — so it has to be asserted.
  const got = await stores.events.betweenDates!(ORG, "2026-02-15", "2026-03-15");
  assert.deepEqual(got.map((e) => e.campaignId).sort(), ["c-feb", "c-mar"]);
});

test("events are returned regardless of which campaign they belong to", async () => {
  // The whole point: on the base table these live in different partitions, so
  // the old path needed one read per campaign.
  for (const c of ["x1", "x2", "x3", "x4"]) await add(c, "2026-06-05T10:00:00.000Z");
  const got = await stores.events.betweenDates!(ORG, "2026-06-01", "2026-06-30");
  assert.deepEqual(got.map((e) => e.campaignId).sort(), ["x1", "x2", "x3", "x4"]);
});

test("the last instant of the final day is inside the window", async () => {
  await add("c-edge", "2026-07-31T23:59:59.999Z");
  const got = await stores.events.betweenDates!(ORG, "2026-07-01", "2026-07-31");
  assert.equal(got.length, 1, "an event at 23:59 on the final day was excluded");
});

test("another org's events are in a different shard entirely", async () => {
  await stores.events.append({
    orgId: "other", subscriberId: "s1", campaignId: "theirs", type: "sent",
    at: "2026-03-10T10:00:00.000Z",
  });
  const got = await stores.events.betweenDates!(ORG, "2026-03-01", "2026-03-31");
  assert.ok(!got.some((e) => e.orgId !== ORG), "cross-org leak");
});
