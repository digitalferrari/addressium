/**
 * Integration test: DynamoStores does NOT truncate large result sets (#97).
 *
 * A single DynamoDB Query page is capped at ~1MB. This test writes more than
 * 1MB of subscribers into one org partition, then proves:
 *   1. a raw single Query is truncated (returns < N items + a LastEvaluatedKey), and
 *   2. `subscribers.list` (which uses the adapter's `queryAll` loop) returns ALL N.
 * Together that shows the LastEvaluatedKey pagination loop is load-bearing, not
 * decorative. Runs against `dynalite` (pure-JS DynamoDB, no Docker).
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
  DynamoDBClient,
  CreateTableCommand,
  QueryCommand,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { Subscriber } from "@addressium/core";
import { DynamoStores } from "@addressium/adapters-aws";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-pg";
const ORG = "bulkorg";
const N = 400; // ~4KB each ⇒ ~1.6MB, comfortably past the 1MB single-page cap.
const PAD = "x".repeat(4000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let endpoint: string;

const mkClient = () =>
  new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
  });

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  endpoint = `http://127.0.0.1:${port}`;

  const throughput = { ReadCapacityUnits: 1, WriteCapacityUnits: 1 };
  const input: CreateTableCommandInput = {
    TableName: TABLE,
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: throughput,
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      { AttributeName: "gsi1pk", AttributeType: "S" },
      { AttributeName: "gsi1sk", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "gsi1",
        KeySchema: [
          { AttributeName: "gsi1pk", KeyType: "HASH" },
          { AttributeName: "gsi1sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
        ProvisionedThroughput: throughput,
      },
    ],
  };
  await mkClient().send(new CreateTableCommand(input));
});

after(() => {
  server?.close();
});

test("subscribers.list returns every item when the result set exceeds one Query page", async () => {
  const client = mkClient();
  const stores = new DynamoStores(TABLE, client);

  for (let i = 0; i < N; i++) {
    const sub: Subscriber = {
      orgId: ORG,
      sub: `s${String(i).padStart(4, "0")}`,
      email: `u${i}@example.com`,
      attributes: { bio: PAD },
      status: "active",
      entitlement: "free",
    };
    await stores.subscribers.put(sub);
  }

  // 1) A single raw Query page is truncated well short of N and hands back a
  //    cursor — proof the partition genuinely spans more than one page here.
  const onePage = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":pk": { S: `ORG#${ORG}` }, ":s": { S: "SUBSCRIBER#" } },
    }),
  );
  assert.ok((onePage.Items?.length ?? 0) < N, "expected a single page to be truncated");
  assert.ok(onePage.LastEvaluatedKey, "expected a LastEvaluatedKey on the truncated page");

  // 2) The adapter's queryAll loop follows the cursor and returns everything.
  const all = await stores.subscribers.list(ORG);
  assert.equal(all.length, N);
  assert.equal(new Set(all.map((s) => s.sub)).size, N);
});
