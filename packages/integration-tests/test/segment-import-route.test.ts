/**
 * Service-level: `POST /orgs/{org}/import/segment`, segment migration route test.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoStores } from "@addressium/adapters-aws";
import { GSI_NO_ANY, GSI_MULTIPLE_LISTS, type SegmentPredicate } from "@addressium/segment";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-segment-import-test";
const ORG = "summit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let api: typeof import("@addressium/svc-api");

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint;
  process.env.AWS_REGION ??= "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "local";
  process.env.AWS_SECRET_ACCESS_KEY = "local";
  process.env.TABLE_NAME = TABLE;

  const throughput = { ReadCapacityUnits: 1, WriteCapacityUnits: 1 };
  const gsi = (n: string) => ({
    IndexName: n,
    KeySchema: [
      { AttributeName: `${n}_pk`, KeyType: "HASH" as const },
      { AttributeName: `${n}_sk`, KeyType: "RANGE" as const },
    ],
    Projection: { ProjectionType: "ALL" as const },
    ProvisionedThroughput: throughput,
  });

  const client = new DynamoDBClient({ endpoint });
  await client.send(
    new CreateTableCommand({
      TableName: TABLE,
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" as const },
        { AttributeName: "sk", KeyType: "RANGE" as const },
      ],
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1_pk", AttributeType: "S" },
        { AttributeName: "gsi1_sk", AttributeType: "S" },
        { AttributeName: "gsi2_pk", AttributeType: "S" },
        { AttributeName: "gsi2_sk", AttributeType: "S" },
        { AttributeName: "gsi3_pk", AttributeType: "S" },
        { AttributeName: "gsi3_sk", AttributeType: "S" },
      ],
      GlobalSecondaryIndexes: [gsi("gsi1"), gsi("gsi2"), gsi("gsi3")],
      ProvisionedThroughput: throughput,
    }),
  );

  // Lazy import of service-api so environment variables are registered first.
  api = await import("@addressium/svc-api");
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// A JWT helper matching the format `grantFromClaims` uses
function claims(role: string, orgs: string) {
  return { sub: "admin-user", "custom:role": role, "custom:orgs": orgs };
}

test("segment save rejects unsupported GSI audiences before persistence and preserves OpenSearch support", async () => {
  const previousEngine = process.env.SEGMENT_ENGINE;
  const stores = new DynamoStores(TABLE);
  const supported: SegmentPredicate = {
    match: "all", conditions: [{ field: "list", op: "in", value: "ledger" }],
  };
  const save = (segmentId: string, predicate: SegmentPredicate) => api.segmentsHandler({
    requestContext: {
      http: { method: "POST" },
      authorizer: { jwt: { claims: claims("editor", ORG) } },
    },
    body: JSON.stringify({ orgId: ORG, segmentId, name: "Audience", predicate }),
  });
  const unsupported: [SegmentPredicate, string][] = [
    [{ match: "any", conditions: [{ field: "plan", op: "eq", value: "gold" }] }, GSI_NO_ANY],
    [{ match: "any", conditions: [
      { field: "list", op: "in", value: "ledger" },
      { field: "plan", op: "eq", value: "gold" },
    ] }, GSI_NO_ANY],
    [{ match: "all", conditions: [
      { field: "list", op: "in", value: "ledger" },
      { field: "list", op: "in", value: "weekly" },
    ] }, GSI_MULTIPLE_LISTS],
  ];
  try {
    process.env.SEGMENT_ENGINE = "gsi";
    assert.equal((await save("existing-audience", supported)).statusCode, 200);
    assert.equal((await save("explicit-audience", { match: "explicit", subscriberIds: ["s1"] })).statusCode, 200);
    for (const [i, [predicate, error]] of unsupported.entries()) {
      for (const segmentId of [`rejected-audience-${i}`, "existing-audience"]) {
        const response = await save(segmentId, predicate);
        assert.equal(response.statusCode, 400);
        assert.equal(JSON.parse(response.body).error, error);
      }
      assert.equal(await stores.segments.get(ORG, `rejected-audience-${i}`), undefined);
      assert.deepEqual((await stores.segments.get(ORG, "existing-audience"))?.predicate, supported);
    }
    process.env.SEGMENT_ENGINE = "opensearch";
    for (const [i, [predicate]] of unsupported.entries()) {
      const segmentId = `opensearch-audience-${i}`;
      assert.equal((await save(segmentId, predicate)).statusCode, 200);
      assert.deepEqual((await stores.segments.get(ORG, segmentId))?.predicate, predicate);
    }
  } finally {
    if (previousEngine === undefined) delete process.env.SEGMENT_ENGINE;
    else process.env.SEGMENT_ENGINE = previousEngine;
  }
});

test("POST /orgs/{org}/import/segment imports dynamic Pinpoint segment", async () => {
  const pinpointSegment = {
    Id: "pinpoint-seg-id",
    Name: "Dynamic Sports",
    Dimensions: {
      Attributes: {
        "SD_Sports": {
          AttributeType: "INCLUSIVE",
          Values: ["true"],
        },
      },
    },
  };

  const res = await api.importSegmentHandler({
    requestContext: {
      routeKey: "POST /orgs/{org}/import/segment",
      http: { method: "POST" },
      authorizer: { jwt: { claims: claims("editor", ORG) } },
    },
    pathParameters: { org: ORG },
    body: JSON.stringify({
      segmentId: "mapped-seg-1",
      pinpointSegment,
    }),
  });

  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.segmentId, "mapped-seg-1");
  assert.equal(parsed.name, "Dynamic Sports");

  // Verify stored in the DB
  const stores = new DynamoStores(TABLE);
  const stored = await stores.segments.get(ORG, "mapped-seg-1");
  assert.ok(stored);
  assert.equal(stored.name, "Dynamic Sports");
});

test("POST /orgs/{org}/import/segment is forbidden for wrong org scope (RBAC)", async () => {
  const pinpointSegment = { Id: "foo", Name: "VIPs" };

  const res = await api.importSegmentHandler({
    requestContext: {
      routeKey: "POST /orgs/{org}/import/segment",
      http: { method: "POST" },
      authorizer: { jwt: { claims: claims("editor", "other-org") } },
    },
    pathParameters: { org: ORG },
    body: JSON.stringify({
      segmentId: "mapped-seg-2",
      pinpointSegment,
    }),
  });

  assert.equal(res.statusCode, 403);
});

test("POST /orgs/{org}/import/segment is forbidden for read-only role (RBAC)", async () => {
  const pinpointSegment = { Id: "foo", Name: "VIPs" };

  const res = await api.importSegmentHandler({
    requestContext: {
      routeKey: "POST /orgs/{org}/import/segment",
      http: { method: "POST" },
      authorizer: { jwt: { claims: claims("analyst", ORG) } },
    },
    pathParameters: { org: ORG },
    body: JSON.stringify({
      segmentId: "mapped-seg-3",
      pinpointSegment,
    }),
  });

  assert.equal(res.statusCode, 403);
});
