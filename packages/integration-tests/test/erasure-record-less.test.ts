import test, { before, after } from "node:test";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import assert from "node:assert/strict";
import { DynamoStores } from "@addressium/adapters-aws";

const require = createRequire(import.meta.url);
const dynalite = require("dynalite") as (opts?: unknown) => any;
const TABLE = "erasure-probe";
const ORG = "summit";
let server: any;
let stores: DynamoStores;
/** The id shape drip and re-engagement mint: a send with no campaign record. */
const RECORD_LESS = "reengage:ledger:1:2026-01-01T00:00:00.000Z";

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
    AttributeDefinitions: ["pk","sk","gsi1pk","gsi1sk","gsi2pk","gsi2sk","gsi3pk","gsi3sk"]
      .map((AttributeName) => ({ AttributeName, AttributeType: "S" as const })),
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" as const }, { AttributeName: "sk", KeyType: "RANGE" as const }],
    GlobalSecondaryIndexes: [gsi("gsi1"), gsi("gsi2"), gsi("gsi3")],
  }));
  stores = new DynamoStores(TABLE, client, { nonTransactionalCountersForTests: true });
});
after(async () => { await new Promise<void>((r) => server.close(r)); });

test("erasure reaches events on a record-less send id (#293, #164)", async () => {
  const SUB = "s-erase";
  // (a) an id WITH a campaign record
  await stores.campaigns.put({
    orgId: ORG, campaignId: "normal-1", listId: "l", subject: "s",
    status: "sent", type: "one_off",
    counters: { sent:0,delivered:0,opens:0,clicks:0,bounces:0,complaints:0,unsubscribes:0,rejects:0,renderingFailures:0,deliveryDelays:0 },
  } as never);
  await stores.events.append({ orgId: ORG, subscriberId: SUB, campaignId: "normal-1", type: "sent", at: new Date().toISOString() });
  // (b) a RECORD-LESS id, the shape drip/re-engagement mint
  await stores.events.append({ orgId: ORG, subscriberId: SUB, campaignId: RECORD_LESS, type: "sent", at: new Date().toISOString() });

  const removed = await stores.events.deleteForSubscriber(ORG, SUB);

  assert.equal(
    (await stores.events.all(ORG, "normal-1")).length, 0,
    "a campaign WITH a record was always erased correctly",
  );
  // The regression. `deleteForSubscriber` walks `campaigns.list`, which returns
  // only `CAMPAIGNREC#` rows — so a drip or re-engagement id was invisible to it
  // and the subject's events survived their erasure request. That is a
  // compliance defect, not a tidiness one.
  assert.equal(
    (await stores.events.all(ORG, RECORD_LESS)).length, 0,
    "personal data survived erasure on a record-less send id",
  );
  assert.equal(removed, 2, "both events counted as removed");
});

test("a record-less send id is NOT listed as a campaign (#293)", async () => {
  // The marker is deliberately an org-partition row rather than a CAMPAIGNREC.
  // `campaigns.list` feeds the console, the trends loop and the reports, and a
  // drip step is not a campaign in any of them.
  const listed = (await stores.campaigns.list(ORG)).map((c) => c.campaignId);
  assert.ok(!listed.includes(RECORD_LESS), `record-less id leaked into campaigns.list: ${listed}`);
});

test("a record-less send id accumulates counters instead of folding events (#293)", async () => {
  const CID = "drip:welcome:2:2026-02-02T00:00:00.000Z";
  for (let i = 0; i < 5; i++) {
    await stores.events.append({ orgId: ORG, subscriberId: `c${i}`, campaignId: CID, type: "sent", at: new Date().toISOString() });
  }
  await stores.events.append({ orgId: ORG, subscriberId: "c0", campaignId: CID, type: "bounce", at: new Date().toISOString() });

  const counters = await stores.sendIdCounters(ORG, CID);
  assert.ok(counters, "the id has no counter row");
  assert.equal(counters.sent, 5, "one per sent event");
  assert.equal(counters.bounces, 1);
  // The point of the index: deliverability can read ONE item instead of folding
  // the whole event log on every bounce and complaint.
  assert.equal(counters.opens, 0, "untouched counters read as zero, not undefined");
});

test("a repeat open registers the id but does not double-count people (#293)", async () => {
  // `opens` counts PEOPLE. A second open by the same person is genuine history
  // (#183) but must not move the counter — and it must still register the id,
  // or an id whose only event is a repeat open stays invisible to erasure.
  const CID = "drip:welcome:3:2026-02-02T00:00:00.000Z";
  const at = () => new Date().toISOString();
  await stores.events.append({ orgId: ORG, subscriberId: "r1", campaignId: CID, type: "open", at: at() });
  await stores.events.append({ orgId: ORG, subscriberId: "r1", campaignId: CID, type: "open", at: at() });

  const counters = await stores.sendIdCounters(ORG, CID);
  assert.ok(counters, "the id was never registered");
  assert.equal(counters.opens, 1, "two opens by one person is one person");
});

test("an unknown send id returns undefined so the caller still folds (#293)", async () => {
  // Ids whose events predate this index must keep working — the fold is the
  // correct fallback, not an error.
  assert.equal(await stores.sendIdCounters(ORG, "never-seen"), undefined);
});
