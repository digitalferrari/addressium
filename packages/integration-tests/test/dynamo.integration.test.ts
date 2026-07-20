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
  const stores = new DynamoStores(TABLE, client);
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
