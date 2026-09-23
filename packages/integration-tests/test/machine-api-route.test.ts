/**
 * The machine API fails closed, identically, for every reason (#291).
 *
 * "Revoked, unknown, cross-org, and insufficient-scope keys fail without
 * leaking state" is really ONE property, and it is the property a credential
 * surface is worth nothing without. Each of those four is a different fact an
 * attacker probing keys would like to learn, so each must be indistinguishable
 * from the others: same status, same body, and no side effect.
 *
 * In particular the insufficient-scope case must NOT be a 403. A 403 says "this
 * key is real, belongs to this org, and is not revoked — it just lacks one
 * scope", which is most of what the prober wanted.
 *
 * Driven through the exported handlers against real `DynamoStores` on dynalite,
 * so the `APIKEYHASH#` lookup and the `lastUsedAt` write are genuinely
 * exercised rather than stubbed.
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

const TABLE = "addressium-machine-api";
const ORG = "summit";
const OTHER_ORG = "northwind";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let api: typeof import("@addressium/svc-api");
let stores: DynamoStores;

/** Plaintext keys minted in `before`, by what makes each one interesting. */
const keys: Record<string, string> = {};

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

  stores = new DynamoStores(TABLE, client);
  for (const orgId of [ORG, OTHER_ORG]) {
    await stores.organizations.put({
      orgId, name: orgId, domains: ["example.com"], sesConfigSet: "cs",
      ipMode: "shared", suppressionScope: "hybrid", defaultTimezone: "UTC",
      setupComplete: true,
    });
  }

  const domain = await import("@addressium/domain");
  const clock = new domain.SystemClock();
  const issue = async (orgId: string, keyId: string, scopes: string[]) =>
    (await domain.issueApiKey(stores, clock, {
      orgId, keyId, name: keyId, scopes: scopes as never,
    }, "admin-1")).plaintext;

  keys.full = await issue(ORG, "full", ["subscribers:read", "suppression:write", "campaigns:read"]);
  // Holds a real scope, but not one ANY machine route requires — so it is
  // "insufficient" for every route in the table rather than only for some.
  keys.noScope = await issue(ORG, "no-scope", ["entitlement:write"]);
  keys.crossOrg = await issue(OTHER_ORG, "cross", ["subscribers:read"]); // right scope, wrong org
  keys.revoked = await issue(ORG, "revoked", ["subscribers:read"]);
  await domain.revokeApiKey(stores, clock, ORG, "revoked");

  // A subscriber to read back on the happy path.
  await stores.subscribers.put({
    orgId: ORG, sub: "s1", email: "reader@example.com", status: "active",
    entitlement: "free", attributes: {},
  });

  api = await import("@addressium/svc-api");
});

after(() => server?.close());

const get = (path: Record<string, string>, key?: string) => ({
  pathParameters: path,
  headers: key ? { authorization: `Bearer ${key}` } : {},
  requestContext: { http: { method: "GET", path: "/v1" } },
});

/** Every machine route, with the scope it demands and a caller for it. */
const ROUTES = [
  {
    name: "GET subscriber",
    call: (key?: string) => api.machineGetSubscriberHandler(
      get({ org: ORG, email: "reader@example.com" }, key) as never,
    ),
  },
  {
    name: "GET campaigns",
    call: (key?: string) => api.machineListCampaignsHandler(get({ org: ORG }, key) as never),
  },
  {
    name: "POST suppression",
    call: (key?: string) => api.machineSuppressHandler({
      pathParameters: { org: ORG },
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: JSON.stringify({ email: "reader@example.com" }),
      requestContext: { http: { method: "POST", path: "/v1" } },
    } as never),
  },
] as const;

for (const route of ROUTES) {
  test(`${route.name}: every bad key fails identically`, async () => {
    const cases: [string, string | undefined][] = [
      ["no header", undefined],
      ["unknown key", "ak_deadbeefdeadbeefdeadbeefdeadbeef"],
      ["revoked key", keys.revoked],
      ["cross-org key", keys.crossOrg],
      ["insufficient scope", keys.noScope],
      ["malformed header", "not-a-bearer-token"],
    ];

    const seen = new Set<string>();
    for (const [label, key] of cases) {
      const res = await route.call(key);
      assert.equal(res.statusCode, 401, `${label} should be 401, got ${res.statusCode}`);
      seen.add(`${res.statusCode}|${res.body}`);
      // Nothing about WHY, and nothing about the org or the resource.
      assert.ok(!res.body.includes(ORG), `${label} leaked the org id`);
      assert.ok(!res.body.includes(OTHER_ORG), `${label} leaked the other org id`);
      assert.ok(!/revok|scope|expired|unknown|not found/i.test(res.body), `${label} leaked a reason: ${res.body}`);
    }
    // The whole point: all six are the SAME response.
    assert.equal(seen.size, 1, `responses differ between causes: ${[...seen].join(" / ")}`);
  });
}

test("a rejected key does not move lastUsedAt", async () => {
  // `lastUsedAt` is a record of USE. A failed authentication is not use, and a
  // column that moved on rejection would let a prober confirm a key exists by
  // watching the console.
  const before = (await stores.apiKeys.get(ORG, "revoked"))?.lastUsedAt;
  await ROUTES[0].call(keys.revoked);
  await ROUTES[0].call(keys.crossOrg);
  await ROUTES[0].call("ak_deadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal((await stores.apiKeys.get(ORG, "revoked"))?.lastUsedAt, before);
});

test("a valid key with the right scope works, and records its use", async () => {
  // The negative tests above would pass against a handler that rejected
  // everything, so this is what makes them meaningful.
  const res = await ROUTES[0].call(keys.full);
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body) as { email: string };
  assert.equal(body.email, "reader@example.com");

  const used = await stores.apiKeys.get(ORG, "full");
  assert.ok(used?.lastUsedAt, "a successful call must record lastUsedAt");
});

test("campaigns and suppression also work with a scoped key", async () => {
  assert.equal((await ROUTES[1].call(keys.full)).statusCode, 200);
  assert.equal((await ROUTES[2].call(keys.full)).statusCode, 202);
});
