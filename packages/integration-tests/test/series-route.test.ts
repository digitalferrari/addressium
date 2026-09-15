/**
 * Service-level: the CampaignSeries CRUD routes.
 *
 * The domain tests (`packages/domain/test/series.test.ts`) call
 * `saveCampaignSeries` directly, which BYPASSES zod. That leaves the two
 * behaviors most likely to break at the wire unexercised, and both matter to the
 * Ad tags screen this unblocks:
 *
 *  1. A caller-supplied `binding` on an ad fill must not survive. The domain
 *     stamps the binding from the series being saved, but if zod let the field
 *     through into the object the domain spread, a payload could claim a fill
 *     belongs to another series. Tested here through a real JSON body.
 *  2. `version` defaults. The Ad tags screen may omit it on a first save.
 *
 * And the capability gates: a series carries the template and the ad HTML every
 * future edition renders, so writing one is `campaigns:manage`. Nothing else in
 * the suite exercises that — route parity is satisfied by an empty handler.
 *
 * Driven through the exported handler against a real DynamoDB API (dynalite) and
 * real `DynamoStores`, so the `SERIES#` sort-key prefix and the list query are
 * exercised rather than a Map.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import type { CampaignSeries, Template } from "@addressium/core";
import { DynamoStores } from "@addressium/adapters-aws";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-series-route";
const ORG = "summit";
const TEMPLATE = "ledger-weekly";

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
      { AttributeName: `${n}pk`, KeyType: "HASH" as const },
      { AttributeName: `${n}sk`, KeyType: "RANGE" as const },
    ],
    Projection: { ProjectionType: "ALL" as const },
    ProvisionedThroughput: throughput,
  });
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  await client.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PROVISIONED",
      ProvisionedThroughput: throughput,
      AttributeDefinitions: ["pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk", "gsi3pk", "gsi3sk"].map(
        (AttributeName) => ({ AttributeName, AttributeType: "S" as const }),
      ),
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" as const },
        { AttributeName: "sk", KeyType: "RANGE" as const },
      ],
      GlobalSecondaryIndexes: [gsi("gsi1"), gsi("gsi2"), gsi("gsi3")],
    }),
  );

  const stores = new DynamoStores(TABLE, client);
  const template: Template = {
    orgId: ORG,
    templateId: TEMPLATE,
    name: "Ledger weekly",
    mode: "mjml",
    source: "<mjml></mjml>",
    version: 1,
    mergeTags: [],
    adSlots: ["ad_top"],
  };
  await stores.templates.put(template);

  api = await import("@addressium/svc-api");
});

after(() => server?.close());

/** A POST event, authorized as `role` unless told otherwise. */
function postEvent(body: Record<string, unknown>, role = "developer_admin", orgs = ORG) {
  return {
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "POST", sourceIp: "203.0.113.7" },
      authorizer: { jwt: { claims: { "custom:role": role, "custom:orgs": orgs, sub: "admin-1" } } },
    },
  };
}

/** A GET event for the list (no id) or one series (`id`). */
function getEvent(id?: string, role = "developer_admin", orgs = ORG) {
  return {
    pathParameters: { org: ORG, ...(id === undefined ? {} : { id }) },
    requestContext: {
      http: { method: "GET", sourceIp: "203.0.113.7" },
      authorizer: { jwt: { claims: { "custom:role": role, "custom:orgs": orgs, sub: "admin-1" } } },
    },
  };
}

const body = {
  orgId: ORG,
  seriesId: "ledger",
  name: "The Ledger",
  cadence: "weekly",
  templateId: TEMPLATE,
};

test("POST creates a series and GET reads it back through Dynamo", async () => {
  const res = await api.seriesHandler(postEvent(body));
  assert.equal(res.statusCode, 200);

  const one = await api.seriesHandler(getEvent("ledger"));
  assert.equal(one.statusCode, 200);
  const series = JSON.parse(one.body) as CampaignSeries;
  assert.equal(series.name, "The Ledger");
  assert.equal(series.cadence, "weekly");
  assert.equal(series.aggregate.sent, 0);

  const all = await api.seriesHandler(getEvent());
  assert.equal(all.statusCode, 200);
  const rows = JSON.parse(all.body) as CampaignSeries[];
  assert.ok(rows.some((r) => r.seriesId === "ledger"), "the SERIES# prefix query finds it");
});

test("a series that does not exist is a 404, not an empty 200", async () => {
  const res = await api.seriesHandler(getEvent("no-such-series"));
  assert.equal(res.statusCode, 404);
});

/**
 * The reason these routes exist. An ad fill posted as real JSON must round-trip
 * its html, and come back bound to THIS series — that binding is what tells the
 * renderer the fill applies to every edition.
 */
test("adSlotFills round-trip through the wire and are bound to this series", async () => {
  const res = await api.seriesHandler(
    postEvent({
      ...body,
      seriesId: "fills",
      adSlotFills: [{ slot: "ad_top", html: "<a href='https://example.com'>ad</a>", version: 4 }],
    }),
  );
  assert.equal(res.statusCode, 200);

  const read = await api.seriesHandler(getEvent("fills"));
  const series = JSON.parse(read.body) as CampaignSeries;
  assert.equal(series.adSlotFills[0]?.html, "<a href='https://example.com'>ad</a>");
  assert.equal(series.adSlotFills[0]?.version, 4);
  assert.deepEqual(series.adSlotFills[0]?.binding, { kind: "series", seriesId: "fills" });
});

/**
 * The cross-series write, attempted the way it would actually arrive: as a JSON
 * field. zod's object strips the unknown key and the domain stamps the binding,
 * so neither layer alone is load-bearing — but the payload must not win.
 */
test("a binding smuggled in the POST body cannot point a fill at another series", async () => {
  const res = await api.seriesHandler(
    postEvent({
      ...body,
      seriesId: "stamped",
      adSlotFills: [
        { slot: "ad_top", html: "<b>ad</b>", binding: { kind: "series", seriesId: "victim" } },
      ],
    }),
  );
  assert.equal(res.statusCode, 200);
  const series = JSON.parse(res.body) as CampaignSeries;
  assert.deepEqual(
    series.adSlotFills[0]?.binding,
    { kind: "series", seriesId: "stamped" },
    "the binding is stamped from the series being saved, never taken from the caller",
  );
  // Omitted by the caller, so the schema's default is what the renderer sees.
  assert.equal(series.adSlotFills[0]?.version, 1, "version defaults rather than arriving undefined");
});

/**
 * `one_off` is a valid member of the shared cadence enum, so zod accepts it and
 * the refusal must come from the domain — as an InvalidInputError, which `fail()`
 * answers 400 with the sentence the operator needs (#265), not a generic 500.
 */
test("a one_off cadence is a readable 400, not a 500", async () => {
  const res = await api.seriesHandler(postEvent({ ...body, seriesId: "bad", cadence: "one_off" }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /cannot be one_off/);
});

test("a template that does not exist is a readable 400", async () => {
  const res = await api.seriesHandler(postEvent({ ...body, seriesId: "ghosted", templateId: "ghost" }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /No template "ghost"/);
});

/**
 * Writing a series sets the template and the verbatim ad HTML every future
 * edition will carry — the same authority as editing a campaign.
 */
test("writing a series is gated on campaigns:manage", async () => {
  for (const role of ["analyst", "support"]) {
    const res = await api.seriesHandler(postEvent({ ...body, seriesId: "denied" }, role));
    assert.equal(res.statusCode, 403, `${role} must not create a series`);
  }
  // An editor HAS campaigns:manage, asserted so the gate is not simply "deny all".
  const editor = await api.seriesHandler(postEvent({ ...body, seriesId: "by-editor" }, "editor"));
  assert.equal(editor.statusCode, 200);
});

test("reading a series is gated on reports:view, which an analyst has", async () => {
  const res = await api.seriesHandler(getEvent(undefined, "analyst"));
  assert.equal(res.statusCode, 200, "an analyst can read the series list");
});

test("a caller scoped to another org cannot read or write this one's series", async () => {
  const read = await api.seriesHandler(getEvent(undefined, "developer_admin", "vail"));
  assert.equal(read.statusCode, 403);
  const write = await api.seriesHandler(postEvent({ ...body, seriesId: "x-org" }, "developer_admin", "vail"));
  assert.equal(write.statusCode, 403);
});
