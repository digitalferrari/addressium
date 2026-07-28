/**
 * Integration test: the full journey against a REAL DynamoDB API.
 *
 * Uses `dynalite` (a pure-JS DynamoDB implementation — no Java/Docker) so the
 * DynamoStores adapter is exercised for real: PutItem, GetItem, Query, GSIs and
 * the confirmed-status filter. This is the same flow the unit tests run against
 * in-memory stores, now proving the adapter.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
  DynamoDBClient,
  CreateTableCommand,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import { generateKeyPair } from "jose";
import type { List } from "@addressium/core";
import { DynamoStores } from "@addressium/adapters-aws";
import {
  CaptureSender,
  HmacConfirmationSigner,
  JoseMagicLinkSigner,
  SystemClock,
  buildClickMap,
  confirmOptIn,
  recordClick,
  sendCampaign,
  signup,
  unsubscribeFromList,
  type EmailTemplate,
} from "@addressium/domain";

const require = createRequire(import.meta.url);
// dynalite ships no types; require returns a factory function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium";
const ORG = "summit";
const LIST = "ledger";
const ARTICLE = "https://northwindtimes.example/markets/the-chart";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let endpoint: string;

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  endpoint = `http://127.0.0.1:${port}`;

  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
  });
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
      { AttributeName: "gsi2pk", AttributeType: "S" },
      { AttributeName: "gsi2sk", AttributeType: "S" },
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
      {
        IndexName: "gsi2",
        KeySchema: [
          { AttributeName: "gsi2pk", KeyType: "HASH" },
          { AttributeName: "gsi2sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
        ProvisionedThroughput: throughput,
      },
    ],
  };
  await client.send(new CreateTableCommand(input));
});

after(() => {
  server?.close();
});

test("signup → confirm → send → click → click map, then unsubscribe (on DynamoDB)", async () => {
  const clock = new SystemClock();
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
  });
  const stores = // dynalite implements no TransactWriteItems action, so the transactional
  // counter append (#221) cannot run here. Exactly-once is proven by the unit
  // tests against memStores and must be re-verified against real DynamoDB
  // (#212). This flag keeps the rest of the journey exercisable.
  new DynamoStores(TABLE, client, { nonTransactionalCountersForTests: true });
  const sender = new CaptureSender();
  const confirmSigner = new HmacConfirmationSigner("secret");
  const { privateKey } = await generateKeyPair("ES256");
  const magic = new JoseMagicLinkSigner(
    { privateKey, kid: "k1", issuer: "iss", audience: "aud", ttlSeconds: 3600 },
    clock,
  );

  // Organization store round-trips (get + list via gsi1 "ORGS").
  await stores.organizations.put({
    orgId: ORG,
    name: "Northwind Times",
    domains: ["northwindtimes.example"],
    subscriberPoolId: "us-east-1_Smt",
    magicLink: {
      kmsKeyArn: "arn:aws:kms:...:key/1",
      kid: "k1",
      issuer: "https://addressium/summit",
      audience: "northwindtimes.example",
    },
    sesConfigSet: "summit-cs",
    ipMode: "shared",
    suppressionScope: "hybrid",
    defaultTimezone: "America/Denver",
    setupComplete: true,
  });
  assert.equal((await stores.organizations.get(ORG))?.defaultTimezone, "America/Denver");
  assert.equal((await stores.organizations.list()).length, 1);

  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "The Morning Ledger",
    optInPolicy: "double",
    fromAddress: "ledger@northwindtimes.example",
    access: "free",
    visibility: "open",
    complianceFooter: "Northwind Times",
    physicalAddress: "123 Main Street, Anytown, USA",
  };
  await stores.lists.put(list);

  const template: EmailTemplate = {
    blocks: [
      { kind: "text", html: "Good morning, {{first_name}}." },
      { kind: "editorial", label: "the chart", url: ARTICLE },
    ],
  };

  const res = await signup(stores, confirmSigner, clock, {
    orgId: ORG,
    email: "jordan@example.com",
    listId: LIST,
    attributes: { first_name: "Jordan" },
  });
  await confirmOptIn(stores, confirmSigner, clock, res.confirmationToken);

  // findByEmail via GSI1 round-trips
  const found = await stores.subscribers.findByEmail(ORG, "jordan@example.com");
  assert.equal(found?.sub, res.subscriber.sub);

  const out = await sendCampaign(stores, sender, magic, clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "The one chart",
    template,
  });
  assert.equal(out.sent, 1);
  const html = sender.sent[0]?.html ?? "";
  assert.match(html, /Good morning, Jordan\./);

  await recordClick(stores, clock, {
    orgId: ORG,
    campaignId: "c1",
    subscriberId: res.subscriber.sub,
    clickedUrl: `${ARTICLE}#tok=redactme`,
  });
  const map = await buildClickMap(stores, ORG, "c1");
  assert.equal(map.sent, 1);
  assert.equal(map.rows.find((r) => r.linkId === "l0")?.clicks, 1);

  // listBySubscriber via GSI2, then unsubscribe stops the next send
  const subs = await stores.subscriptions.listBySubscriber(ORG, res.subscriber.sub);
  assert.equal(subs.length, 1);
  await unsubscribeFromList(stores, clock, {
    orgId: ORG,
    subscriberId: res.subscriber.sub,
    listId: LIST,
  });
  sender.sent.length = 0;
  const out2 = await sendCampaign(stores, sender, magic, clock, {
    orgId: ORG,
    campaignId: "c2",
    listId: LIST,
    subject: "x",
    template,
  });
  assert.equal(out2.sent, 0);
});

/**
 * Import batches against the real API (#223).
 *
 * The in-memory store cannot show the thing that matters here: batch rows live
 * in a partition of their own, so listing a batch's memberships must not depend
 * on — or pollute — the org partition every other query ranges over.
 */
test("a batch's rows are enumerable, and live outside the org partition", async () => {
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
  });
  const stores = new DynamoStores(TABLE, client, { nonTransactionalCountersForTests: true });
  const ORG = "batchorg";

  await stores.importBatches.put({
    orgId: ORG,
    batchId: "b1",
    sourceFile: "pinpoint.csv",
    startedAt: "2026-07-01T00:00:00.000Z",
    created: 2,
    updated: 0,
    subscriptionsCreated: 3,
    rowCount: 3,
  });
  await stores.importBatches.put({
    orgId: ORG,
    batchId: "b2",
    startedAt: "2026-07-02T00:00:00.000Z",
    created: 0,
    updated: 1,
    subscriptionsCreated: 1,
    rowCount: 1,
  });

  for (const [sub, list] of [["s1", "l1"], ["s1", "l2"], ["s2", "l1"]]) {
    await stores.importBatches.addRow(ORG, "b1", sub as string, list as string);
  }
  await stores.importBatches.addRow(ORG, "b2", "s3", "l1");

  const b1 = await stores.importBatches.get(ORG, "b1");
  assert.equal(b1?.sourceFile, "pinpoint.csv");

  const listed = await stores.importBatches.list(ORG);
  assert.deepEqual(listed.map((b) => b.batchId), ["b2", "b1"], "newest first");

  const rows = await stores.importBatches.listRows(ORG, "b1");
  assert.equal(rows.length, 3);
  // Scoped to the batch: b2's row must not leak into b1's listing.
  assert.ok(!rows.some((r) => r.subscriberId === "s3"));

  // Re-adding the same membership overwrites its pointer rather than adding a
  // second — an import retry cannot inflate the batch.
  await stores.importBatches.addRow(ORG, "b1", "s1", "l1");
  assert.equal((await stores.importBatches.listRows(ORG, "b1")).length, 3);

  // The rows are NOT in the org partition, so a subscriber listing is unaffected
  // however large the import was. This is the whole reason for the split key.
  assert.deepEqual(await stores.subscribers.list(ORG), []);
});

/**
 * Optimistic concurrency against the real API (#194).
 *
 * The in-memory store checks a field; DynamoDB evaluates a ConditionExpression
 * on a nested attribute and raises a specific exception. Those are different
 * enough that the fake proves nothing about the adapter — a mistyped attribute
 * name or a missing alias would pass every unit test and then never reject
 * anything in production, which is the worst possible failure for a guard.
 */
test("a stale conditional write is refused, and a current one is not", async () => {
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
  });
  const stores = new DynamoStores(TABLE, client, { nonTransactionalCountersForTests: true });
  const ORG = "revorg";

  await stores.subscribers.put({
    orgId: ORG,
    sub: "s1",
    email: "alice@example.com",
    attributes: {},
    status: "active",
    entitlement: "free",
  });
  const first = await stores.subscribers.get(ORG, "s1");
  assert.equal(first?.rev, 1, "the store stamps the counter, not the caller");

  // Someone else writes, moving the rev forward.
  await stores.subscribers.put({ ...first!, attributes: { by: "them" } });

  // Our write, based on what we read before that, must lose.
  await assert.rejects(
    () => stores.subscribers.put({ ...first!, email: "erased:s1" }, { ifRev: first!.rev }),
    (e: Error) => e.name === "ConcurrentModificationError",
  );
  assert.equal((await stores.subscribers.get(ORG, "s1"))?.email, "alice@example.com");

  // Re-reading and retrying against current state succeeds — the guard must be
  // survivable, not just strict.
  const current = await stores.subscribers.get(ORG, "s1");
  await stores.subscribers.put({ ...current!, email: "erased:s1" }, { ifRev: current!.rev });
  assert.equal((await stores.subscribers.get(ORG, "s1"))?.email, "erased:s1");
});

test("the email reservation decides a race and never yields two ids", async () => {
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
  });
  const stores = new DynamoStores(TABLE, client, { nonTransactionalCountersForTests: true });
  const ORG = "resvorg";

  // Genuinely concurrent, not sequential: exactly one conditional Put may win.
  const claims = await Promise.all(
    ["a", "b", "c", "d"].map((id) => stores.subscribers.reserveEmail(ORG, "race@example.com", id)),
  );
  const winners = new Set(claims.map((c) => c.sub));
  assert.equal(winners.size, 1, `four callers agreed on ${winners.size} ids`);

  // The reservation lives outside the org partition, so it never appears in a
  // subscriber listing.
  assert.deepEqual(await stores.subscribers.list(ORG), []);
});
