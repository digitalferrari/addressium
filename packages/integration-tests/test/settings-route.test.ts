/**
 * Service-level: POST /orgs/settings, driven through the exported handler.
 *
 * `hourlyEnabled` is a feature flag the Compose picker reads to decide whether
 * to offer an hourly send frequency, so the route is the only thing standing
 * between an editor and a campaign that fires every hour. Nothing else covered
 * it: the console declares the response type locally in `api.ts`, so tsc and
 * the mocked vitest suite agree with each other without either one touching the
 * real handler.
 *
 * What only exists at the wire, and is therefore asserted here:
 *
 *  1. **The capability gate.** The route is `identity:manage`, which `editor`
 *     does not hold. Route parity is satisfied by an empty handler, so nothing
 *     else would catch a gate that was dropped or widened.
 *  2. **Org scoping.** A grant for one org must not write another's settings,
 *     even with the right capability.
 *  3. **The response shape the console declares** — `{ hourlyEnabled: boolean }`
 *     — asserted against the real JSON body, not against an object the domain
 *     returned.
 *  4. **Persistence and the round trip**, read back through `orgMetaHandler`,
 *     which is what Compose and Settings actually call.
 *  5. **Zod rejection** of a non-boolean flag as a 400, not a 500.
 *
 * Against a real DynamoDB API (dynalite) and real `DynamoStores`.
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

const TABLE = "addressium-settings-route";
const ORG = "summit";
const OTHER_ORG = "northwind";

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
  for (const orgId of [ORG, OTHER_ORG]) {
    await stores.organizations.put({
      orgId,
      name: orgId,
      domains: ["example.com"],
      sesConfigSet: "cs",
      ipMode: "shared",
      suppressionScope: "hybrid",
      defaultTimezone: "UTC",
      setupComplete: true,
    });
  }

  api = await import("@addressium/svc-api");
});

after(() => server?.close());

const claims = (role: string, orgs: string, sub: string) => ({
  authorizer: { jwt: { claims: { "custom:role": role, "custom:orgs": orgs, sub } } },
});

const postEvent = (
  body: Record<string, unknown>,
  role = "developer_admin",
  orgs = ORG,
  sub = "admin-1",
) => ({
  body: JSON.stringify(body),
  requestContext: { http: { method: "POST", sourceIp: "203.0.113.7" }, ...claims(role, orgs, sub) },
});

const metaEvent = (orgId = ORG, role = "developer_admin", orgs = ORG) => ({
  pathParameters: { org: orgId },
  requestContext: { http: { method: "GET", sourceIp: "203.0.113.7" }, ...claims(role, orgs, "admin-1") },
});

test("enabling the flag returns the shape the console declares", async () => {
  const res = await api.settingsHandler(postEvent({ orgId: ORG, hourlyEnabled: true }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as { hourlyEnabled: boolean };
  // api.ts declares `call<{ hourlyEnabled: boolean }>`; this is the real body.
  assert.deepEqual(body, { hourlyEnabled: true });
});

test("the flag persists and is reported by orgMeta", async () => {
  await api.settingsHandler(postEvent({ orgId: ORG, hourlyEnabled: true }));
  // orgMetaHandler is what Compose reads to decide whether to offer hourly.
  const meta = await api.orgMetaHandler(metaEvent());
  assert.equal(meta.statusCode, 200);
  assert.equal((JSON.parse(meta.body) as { hourlyEnabled?: boolean }).hourlyEnabled, true);
});

test("the flag can be turned back off", async () => {
  await api.settingsHandler(postEvent({ orgId: ORG, hourlyEnabled: true }));
  const res = await api.settingsHandler(postEvent({ orgId: ORG, hourlyEnabled: false }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { hourlyEnabled: false });
  const meta = await api.orgMetaHandler(metaEvent());
  assert.equal((JSON.parse(meta.body) as { hourlyEnabled?: boolean }).hourlyEnabled, false);
});

test("an org that never set the flag reports it as false, not undefined", async () => {
  // Compose renders `orgMeta.data?.hourlyEnabled && <option…>`, so a missing
  // field and an explicit false must behave the same.
  const meta = await api.orgMetaHandler(metaEvent(OTHER_ORG, "developer_admin", OTHER_ORG));
  assert.equal(meta.statusCode, 200);
  assert.equal((JSON.parse(meta.body) as { hourlyEnabled?: boolean }).hourlyEnabled, false);
});

test("editor cannot change the flag — it is identity:manage", async () => {
  const res = await api.settingsHandler(postEvent({ orgId: ORG, hourlyEnabled: true }, "editor"));
  assert.equal(res.statusCode, 403);
});

test("a grant for another org cannot write this one's settings", async () => {
  const res = await api.settingsHandler(
    postEvent({ orgId: ORG, hourlyEnabled: true }, "developer_admin", OTHER_ORG),
  );
  assert.equal(res.statusCode, 403);
});

test("an unknown organization is a 404, not a silent create", async () => {
  const res = await api.settingsHandler(
    postEvent({ orgId: "ghost", hourlyEnabled: true }, "developer_admin", "*"),
  );
  assert.equal(res.statusCode, 404);
});

test("a non-boolean flag is a 400 from zod, not a 500", async () => {
  const res = await api.settingsHandler(postEvent({ orgId: ORG, hourlyEnabled: "yes" }));
  assert.equal(res.statusCode, 400);
});

test("a missing flag is rejected rather than defaulting", async () => {
  const res = await api.settingsHandler(postEvent({ orgId: ORG }));
  assert.equal(res.statusCode, 400);
});

test("updating settings preserves the rest of the organization record", async () => {
  // The handler spreads `{ ...org, hourlyEnabled }` and re-puts the whole
  // record, so a dropped field here would silently blank an org's config.
  await api.settingsHandler(postEvent({ orgId: ORG, hourlyEnabled: true }));
  const meta = await api.orgMetaHandler(metaEvent());
  const body = JSON.parse(meta.body) as { name?: string; domains?: string[] };
  assert.equal(body.name, ORG);
  assert.deepEqual(body.domains, ["example.com"]);
});
