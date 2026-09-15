/**
 * What the PUBLIC signup box says when something goes wrong (#265).
 *
 * `/signup` is the most-embedded route in the product and had no service-level
 * test at all, which is how both of these reached the live subscriber site:
 *
 *  1. An address typed without an `@` rendered the entire serialized ZodError —
 *     origin, code, format and the full email regex — as the page's error text.
 *  2. A VALID address rendered the SES sandbox refusal as a 400: an operational
 *     state of ours, blamed on the reader, naming our sending region and echoing
 *     their address back at them. And the signup had already SUCCEEDED — the
 *     send sat inside the same `try` as the persist, so the outer catch turned a
 *     completed subscription into an error.
 *
 * Driven through the exported handler against a real DynamoDB API (dynalite),
 * with only the SES sender swapped, because the point is the response the
 * subscriber actually receives.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoStores } from "@addressium/adapters-aws";
import type { List } from "@addressium/core";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-signup-errors";
const SECRET = "local-test-confirm-secret";
const ORG = "summit";
const LIST = "ledger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let stores: DynamoStores;
let api: typeof import("@addressium/svc-api");

/** The live failure this issue is named for, verbatim in shape (#265). */
const SES_SANDBOX_FAILURE =
  "Email address is not verified. The following identities failed the check in region US-EAST-1: reader@example.com";

/** Runs `fn` with console.error captured, so a 500's log line can be asserted. */
async function capturingLog<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const logged: unknown[][] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: await fn(), logged: JSON.stringify(logged) };
  } finally {
    console.error = real;
  }
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
  // `getSecret` returns a non-ARN verbatim with this set — no Secrets Manager.
  process.env.ADDRESSIUM_LOCAL = "1";
  process.env.CONFIRM_SECRET_ARN = SECRET;
  process.env.CONFIRM_URL_BASE = "https://example.com/confirm";

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

  stores = new DynamoStores(TABLE);
  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "The Ledger",
    visibility: "open",
    optInPolicy: "double",
    fromAddress: "news@example.com",
    access: "free",
    complianceFooter: "You are receiving this because you subscribed.",
    physicalAddress: "1 Example Way, Exampleton",
  };
  await stores.lists.put(list);

  api = await import("@addressium/svc-api");
});

after(() => server?.close());

const signupEvent = (body: Record<string, unknown>) => ({
  body: JSON.stringify(body),
  requestContext: { http: { method: "POST", sourceIp: "203.0.113.9" } },
});

test("an address with no @ gets one sentence, not the email regex", async () => {
  const res = await api.signupHandler(signupEvent({ orgId: ORG, email: "reader.example.com", listId: LIST }));

  assert.equal(res.statusCode, 400, "a malformed address IS the caller's to fix");
  const { error } = JSON.parse(res.body) as { error: string };
  assert.match(error, /valid email address/i);
  // The specific shapes the screenshot showed. Each is independently fatal.
  assert.doesNotMatch(error, /pattern/i, "the regex must not be published");
  assert.doesNotMatch(error, /invalid_format|origin|issues/i, "nor the serialized issue");
  assert.doesNotMatch(error, /\^|\\\\\./, "nor regex syntax of any kind");
  assert.ok(error.length < 120, `one sentence, not a dump (got ${error.length} chars)`);
});

test("a failed confirmation send is OUR 500, and never echoes the address or region", async () => {
  // The signup itself succeeds; SES is what fails. Before #265 the outer catch
  // turned this into a 400 carrying the text below.
  const { result: res, logged } = await capturingLog(() =>
    api.signupHandler(signupEvent({ orgId: ORG, email: "reader@example.com", listId: LIST }), {
      sender: {
        send: async () => {
          throw new Error(SES_SANDBOX_FAILURE);
        },
      },
    }),
  );

  assert.equal(res.statusCode, 500, "an unverified sending identity is ours, not the subscriber's");
  const { error } = JSON.parse(res.body) as { error: string };
  assert.doesNotMatch(error, /US-EAST-1/i, "our region must not be published");
  assert.doesNotMatch(error, /reader@example\.com/, "nor their address echoed back");
  assert.doesNotMatch(error, /identities failed the check/i, "nor the SES text");
  assert.match(error, /something went wrong/i);

  // …but the operator has to be able to find it.
  assert.match(logged, /identities failed the check/, "the real SES error must reach the log");

  // And the signup it belongs to is still durable — which is what makes the
  // subscriber's retry safe rather than a duplicate.
  const subscriber = await stores.subscribers.findByEmail(ORG, "reader@example.com");
  assert.ok(subscriber, "the subscriber was persisted before the send failed");
  const subscription = await stores.subscriptions.get(ORG, subscriber.sub, LIST);
  assert.equal(subscription?.status, "pending", "the subscription survived the failed send");
});

test("a signup whose send succeeds is still a 202", async () => {
  // The guard against over-correcting: only the send's own failure is a 500.
  const res = await api.signupHandler(
    signupEvent({ orgId: ORG, email: "happy@example.com", listId: LIST }),
    { sender: { send: async () => undefined } },
  );
  assert.equal(res.statusCode, 202);
  assert.equal((JSON.parse(res.body) as { status: string }).status, "pending");
});

test("re-submitting after a failed send succeeds — the retry the 500 asks for", async () => {
  // `signup()` is idempotent: findOrCreateSubscriber and pendingSubscription
  // both find-or-create. This is the whole basis for answering 500 (retry) and
  // not 202 ("check your email" when no email is coming).
  const body = { orgId: ORG, email: "retry@example.com", listId: LIST };
  await capturingLog(() =>
    api.signupHandler(signupEvent(body), {
      sender: { send: async () => { throw new Error(SES_SANDBOX_FAILURE); } },
    }),
  );
  const second = await api.signupHandler(signupEvent(body), { sender: { send: async () => undefined } });

  assert.equal(second.statusCode, 202, "the retry must not collide with the first attempt's record");
});

test("/signup/batch has the same posture — the bug was in both handlers", async () => {
  // Asserted rather than assumed from symmetry: the shared-try bug this issue
  // is about was itself two copies of the same shape, and only one of them
  // would have been noticed if the other went untested.
  const { result: res, logged } = await capturingLog(() =>
    api.signupBatchHandler(signupEvent({ orgId: ORG, email: "batch@example.com", listIds: [LIST] }), {
      sender: {
        send: async () => {
          throw new Error(SES_SANDBOX_FAILURE);
        },
      },
    }),
  );

  assert.equal(res.statusCode, 500);
  const { error } = JSON.parse(res.body) as { error: string };
  assert.doesNotMatch(error, /US-EAST-1/i);
  assert.doesNotMatch(error, /batch@example\.com/);
  assert.match(error, /something went wrong/i);
  assert.match(logged, /identities failed the check/, "the real SES error must reach the log");

  const subscriber = await stores.subscribers.findByEmail(ORG, "batch@example.com");
  assert.ok(subscriber, "the subscriber was persisted before the send failed");
  const subscription = await stores.subscriptions.get(ORG, subscriber.sub, LIST);
  assert.equal(subscription?.status, "pending", "the subscription survived the failed send");
});

test("an unknown list is still the caller's 400, with the reason intact", async () => {
  // The other half of the fix: defaulting to 500 must not bury the genuine
  // 400-class errors an operator reads in the console.
  const res = await api.signupHandler(signupEvent({ orgId: ORG, email: "reader@example.com", listId: "nope" }));
  assert.equal(res.statusCode, 400);
  assert.match((JSON.parse(res.body) as { error: string }).error, /unknown list/);
});
