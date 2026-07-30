/**
 * The per-address live SES check/write, at the boundaries #240's suite doesn't
 * cover (#247): the `get`/`put` adapter methods against real command shapes,
 * and the three route changes — a new check route, and the RBAC widened on
 * suppress/unsuppress from `suppression:manage` to `subscribers:manage`.
 *
 * The widening is the part most likely to regress silently: it is a DECREASE
 * in restriction on two existing routes, so a test asserting the OLD gate
 * would have passed right through it. These assert the new gate explicitly,
 * both that the three intended roles get through and that Analyst still does
 * not.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoStores, SesSuppressionListReader } from "@addressium/adapters-aws";
import type { SuppressionChecker } from "@addressium/domain";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-suppression-check";
const ORG = "summit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let client: DynamoDBClient;
let api: typeof import("@addressium/svc-api");

/** Records command NAME + input, and can be told how to answer or throw per name. */
function fakeSes(behavior: Record<string, () => unknown> = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      const b = behavior[name];
      if (b) return b();
      return {};
    },
  };
}

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
  client = new DynamoDBClient({
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
  api = await import("@addressium/svc-api");
});

after(() => server?.close());

// ---------------------------------------------------------------------------
// 1. The adapter — real command shapes
// ---------------------------------------------------------------------------

test("get() sends GetSuppressedDestinationCommand and maps a hit", async () => {
  const ses = fakeSes({
    GetSuppressedDestinationCommand: () => ({
      SuppressedDestination: {
        EmailAddress: "ghost@example.com",
        Reason: "COMPLAINT",
        LastUpdateTime: new Date("2024-01-01T00:00:00.000Z"),
      },
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new SesSuppressionListReader({}, ses as any);
  const got = await reader.get("ghost@example.com");
  assert.deepEqual(got, {
    email: "ghost@example.com",
    reason: "COMPLAINT",
    at: "2024-01-01T00:00:00.000Z",
  });
  assert.deepEqual(ses.calls[0], {
    name: "GetSuppressedDestinationCommand",
    input: { EmailAddress: "ghost@example.com" },
  });
});

test("get() returns undefined on NotFoundException — the expected, common case", async () => {
  const notFound = Object.assign(new Error("not found"), { name: "NotFoundException" });
  const ses = fakeSes({
    GetSuppressedDestinationCommand: () => {
      throw notFound;
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new SesSuppressionListReader({}, ses as any);
  assert.equal(await reader.get("clean@example.com"), undefined);
});

test("get() re-throws anything that is NOT NotFoundException", async () => {
  // The whole reason `checkSuppression` has a `liveError` field distinct from
  // "not suppressed": a throttle or permissions gap must be visible, not read
  // as "SES confirms this address is clear."
  const ses = fakeSes({
    GetSuppressedDestinationCommand: () => {
      throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new SesSuppressionListReader({}, ses as any);
  await assert.rejects(() => reader.get("x@example.com"), /Rate exceeded/);
});

test("put() sends exactly EmailAddress + Reason, nothing else", async () => {
  const ses = fakeSes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new SesSuppressionListReader({}, ses as any);
  await reader.put("bad@example.com", "BOUNCE");
  assert.deepEqual(ses.calls[0], {
    name: "PutSuppressedDestinationCommand",
    input: { EmailAddress: "bad@example.com", Reason: "BOUNCE" },
  });
});

// ---------------------------------------------------------------------------
// 2. GET /orgs/{org}/suppression/check — the new route
// ---------------------------------------------------------------------------

function checkEvent(email: string, role = "developer_admin", orgs = ORG) {
  return {
    pathParameters: { org: ORG },
    queryStringParameters: { email },
    requestContext: {
      http: { method: "GET", sourceIp: "203.0.113.10" },
      authorizer: { jwt: { claims: { "custom:role": role, "custom:orgs": orgs, sub: "a" } } },
    },
  };
}

test("the check route combines local and live, and is gated at subscribers:manage", async () => {
  const stores = new DynamoStores(TABLE, client);
  await stores.suppression.add({
    orgId: ORG,
    email: "known@example.com",
    source: "manual",
    scope: "org",
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  const checker: SuppressionChecker = {
    get: async () => undefined, // SES: clear
    put: async () => {},
  };

  for (const role of ["developer_admin", "editor", "support"]) {
    const res = await api.suppressionCheckHandler(checkEvent("known@example.com", role), { checker });
    assert.equal(res.statusCode, 200, role);
    const body = JSON.parse(res.body) as { local: unknown[]; live: unknown };
    assert.equal(body.local.length, 1, role);
    assert.equal(body.live, null, `${role}: SES was asked and said clear`);
  }

  const denied = await api.suppressionCheckHandler(checkEvent("known@example.com", "analyst"), { checker });
  assert.equal(denied.statusCode, 403);

  const missingEmail = await api.suppressionCheckHandler(
    { ...checkEvent("x"), queryStringParameters: {} },
    { checker },
  );
  assert.equal(missingEmail.statusCode, 400);
});

// ---------------------------------------------------------------------------
// 3. The RBAC widening on suppress/unsuppress (#247)
// ---------------------------------------------------------------------------

function suppressEvent(body: Record<string, unknown>, role = "developer_admin", orgs = ORG) {
  return {
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "POST", sourceIp: "203.0.113.11" },
      authorizer: { jwt: { claims: { "custom:role": role, "custom:orgs": orgs, sub: "a" } } },
    },
  };
}

test("editor and support can now suppress a single address; analyst still cannot", async () => {
  const checker: SuppressionChecker = { get: async () => undefined, put: async () => {} };
  for (const role of ["developer_admin", "editor", "support"]) {
    const email = `${role}@example.com`;
    const res = await api.subscriberSuppressHandler(suppressEvent({ orgId: ORG, email }, role), { checker });
    assert.equal(res.statusCode, 200, role);
    const body = JSON.parse(res.body) as { source: string; scope: string };
    assert.equal(body.source, "manual", role);
    assert.equal(body.scope, "org", role);
  }
  const denied = await api.subscriberSuppressHandler(
    suppressEvent({ orgId: ORG, email: "nope@example.com" }, "analyst"),
    { checker },
  );
  assert.equal(denied.statusCode, 403);
});

test("a bounce/complaint reason mirrors to the live SES list; a bare manual suppress does not", async () => {
  const putCalls: Array<{ email: string; reason: string }> = [];
  const checker: SuppressionChecker = {
    get: async () => undefined,
    put: async (email, reason) => void putCalls.push({ email, reason }),
  };

  await api.subscriberSuppressHandler(
    suppressEvent({ orgId: ORG, email: "manual-only@example.com" }, "editor"),
    { checker },
  );
  assert.deepEqual(putCalls, [], "no stated reason -> org-scoped only, no SES call");

  await api.subscriberSuppressHandler(
    suppressEvent({ orgId: ORG, email: "hard@example.com", source: "bounce" }, "editor"),
    { checker },
  );
  assert.deepEqual(putCalls, [{ email: "hard@example.com", reason: "BOUNCE" }]);

  await api.subscriberSuppressHandler(
    suppressEvent({ orgId: ORG, email: "angry@example.com", source: "complaint" }, "support"),
    { checker },
  );
  assert.deepEqual(putCalls, [
    { email: "hard@example.com", reason: "BOUNCE" },
    { email: "angry@example.com", reason: "COMPLAINT" },
  ]);
});

test("a failed SES mirror write does not fail the suppression that already succeeded locally", async () => {
  // The local entry is what mayMail actually gates on. A throttled or
  // unreachable mirror call is a real gap worth logging, but it must not turn
  // "I suppressed this address" into an error the operator has to retry.
  const stores = new DynamoStores(TABLE, client);
  const failingChecker: SuppressionChecker = {
    get: async () => undefined,
    put: async () => {
      throw new Error("SES unreachable");
    },
  };
  const res = await api.subscriberSuppressHandler(
    suppressEvent({ orgId: ORG, email: "resilient@example.com", source: "bounce" }, "editor"),
    { checker: failingChecker },
  );
  assert.equal(res.statusCode, 200, "the local write still succeeds and is reported as success");
  assert.equal(await stores.suppression.isSuppressed(ORG, "resilient@example.com"), true);
});

test("editor and support can lift an org suppression; analyst cannot", async () => {
  const stores = new DynamoStores(TABLE, client);
  for (const role of ["editor", "support"]) {
    const email = `${role}-lift@example.com`;
    await stores.suppression.add({ orgId: ORG, email, source: "manual", scope: "org", addedAt: "2026-01-01T00:00:00.000Z" });
    const res = await api.subscriberUnsuppressHandler(suppressEvent({ orgId: ORG, email }, role));
    assert.equal(res.statusCode, 200, role);
    assert.equal(await stores.suppression.isSuppressed(ORG, email), false, role);
  }
  const denied = await api.subscriberUnsuppressHandler(
    suppressEvent({ orgId: ORG, email: "whoever@example.com" }, "analyst"),
  );
  assert.equal(denied.statusCode, 403);
});
