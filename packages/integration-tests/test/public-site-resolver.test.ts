/**
 * GET /public/site — which org serves this hostname? (#294)
 *
 * One SPA bundle is published for every org, so it resolves its own org at
 * runtime from the host it was loaded on. This is the lookup behind that.
 *
 * Matched on `siteUrl` rather than `domains`: `domains` are SES sending
 * identities and answer a different question ("who may we mail as"). Two orgs
 * can legitimately send from related domains while serving completely separate
 * subscriber sites.
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

const TABLE = "addressium-public-site";
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

  // Two siloed orgs, each with its own subscriber hostname — the case this
  // route exists for.
  const stores = new DynamoStores(TABLE);
  for (const [orgId, name, siteUrl] of [
    ["identithing", "Identithing", "https://newsletter.identithing.com"],
    ["booklense", "Booklense", "https://newsletter.booklense.com"],
    ["nosite", "No Site Yet", ""],
  ] as [string, string, string][]) {
    await stores.organizations.put({
      orgId, name, domains: [`${orgId}.example`],
      ...(siteUrl ? { siteUrl } : {}),
      sesConfigSet: "cs", ipMode: "shared", suppressionScope: "hybrid",
      defaultTimezone: "UTC", setupComplete: true,
    } as never);
  }

  api = await import("@addressium/svc-api");
});

after(() => server?.close());

const get = (host?: string) =>
  api.publicSiteHandler({
    ...(host !== undefined ? { queryStringParameters: { host } } : {}),
    requestContext: { http: { method: "GET", path: "/public/site" } },
  } as never);

test("each hostname resolves to ITS OWN org", async () => {
  for (const [host, orgId] of [
    ["newsletter.identithing.com", "identithing"],
    ["newsletter.booklense.com", "booklense"],
  ] as [string, string][]) {
    const res = await get(host);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((JSON.parse(res.body) as { orgId: string }).orgId, orgId);
  }
});

test("an unknown host is a 404, never a guess", async () => {
  // Returning "some" org would render a signup form that subscribes a visitor
  // to a publication they never visited.
  const res = await get("newsletter.stranger.example");
  assert.equal(res.statusCode, 404);
  assert.ok(!res.body.includes("identithing"), "must not leak another org");
  assert.ok(!res.body.includes("booklense"));
});

test("an org with no siteUrl configured matches nothing", async () => {
  assert.equal((await get("")).statusCode, 400);
  assert.equal((await get("nosite.example")).statusCode, 404);
});

test("the reply carries only what the page renders", async () => {
  // It is unauthenticated, so it must not become an org inventory.
  const body = JSON.parse((await get("newsletter.booklense.com")).body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["name", "orgId"]);
  for (const leak of ["domains", "sesConfigSet", "suppressionScope", "siteUrl"]) {
    assert.ok(!(leak in body), `${leak} must not be exposed`);
  }
});

test("matching is case-insensitive and ignores the scheme", async () => {
  // Browsers report `window.location.host` lowercased, but a hand-typed or
  // proxied value need not be.
  assert.equal((await get("NEWSLETTER.Booklense.com")).statusCode, 200);
});
