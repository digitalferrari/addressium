/**
 * Service-level: the real `confirmHandler` enrolls, and cannot be broken by the
 * starter (#245).
 *
 * This is the layer the issue was actually about. Everything below it — the
 * domain's enrollment decision, the adapter's StartExecutionCommand — already had
 * tests before the starter existed, because they can be tested without anyone
 * calling them. So this drives the exported handler itself, against a real
 * DynamoDB API (dynalite) and its real `DynamoStores`/`HmacConfirmationSigner`,
 * with only the Step Functions client swapped out. If the confirm path stops
 * enrolling, this fails; a domain-level stub would not have.
 *
 * The last test is the important one: enrollment is a best-effort side effect on
 * a confirmation that is ALREADY durable, and `confirmHandler` turns anything
 * thrown into a 400. So a broken starter must produce a 200 and a log line, not
 * an error on the page that was supposed to say "you're subscribed".
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import type { DripSequence, Subscriber, Subscription } from "@addressium/core";
import { DynamoStores } from "@addressium/adapters-aws";
import { HmacConfirmationSigner, type DripEnrollment, type DripStarter } from "@addressium/domain";

const require = createRequire(import.meta.url);
// dynalite ships no types; require returns a factory function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-confirm-drip";
const SECRET = "local-test-confirm-secret";
const ORG = "summit";
const LIST = "ledger";
const SUB = "s1";
/** The subscriber's opt-in request time — the enrollment identity (#245). */
const REQUESTED_AT = "2027-03-01T09:00:00.000Z";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let api: typeof import("@addressium/svc-api");

/** Captures what would be started, keyed the way Step Functions keys it. */
class CaptureStarter implements DripStarter {
  public started: DripEnrollment[] = [];
  async start(enrollment: DripEnrollment) {
    this.started.push(enrollment);
  }
}

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The API's stores/signer singletons are lazy, so setting these before the
  // first handler call is enough — and is the same mechanism `npm run dev` uses.
  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint;
  process.env.AWS_REGION ??= "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "local";
  process.env.AWS_SECRET_ACCESS_KEY = "local";
  process.env.TABLE_NAME = TABLE;
  // `getSecret` returns a non-ARN verbatim, but only with this set — see
  // adapters-aws/secrets.ts. No Secrets Manager needed.
  process.env.ADDRESSIUM_LOCAL = "1";
  process.env.CONFIRM_SECRET_ARN = SECRET;
  // DRIP_STATE_MACHINE_ARN is deliberately NOT set. The first two tests inject a
  // starter and so never read it; the last one proves that its absence degrades
  // enrollment rather than the confirmation.

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
  const subscriber: Subscriber = {
    orgId: ORG,
    sub: SUB,
    email: "reader@example.com",
    attributes: {},
    status: "active",
    entitlement: "free",
  };
  const pending: Subscription = {
    orgId: ORG,
    subscriberId: SUB,
    listId: LIST,
    status: "pending",
    updatedAt: REQUESTED_AT,
    consent: { requestedAt: REQUESTED_AT, basis: "explicit" },
  };
  const sequence: DripSequence = {
    orgId: ORG,
    sequenceId: "welcome",
    name: "Welcome",
    trigger: { kind: "signup", listId: LIST },
    steps: [
      { stepId: "day3", waitSeconds: 259_200, listId: LIST, templateId: "t", subject: "Welcome" },
      { stepId: "day4", waitSeconds: 86_400, listId: LIST, templateId: "t", subject: "More" },
    ],
  };
  await stores.subscribers.put(subscriber);
  await stores.subscriptions.put(pending);
  await stores.dripSequences.put(sequence);

  api = await import("@addressium/svc-api");
});

after(() => server?.close());

/** A `GET /confirm?token=...` event for the seeded subscription. */
function confirmEvent() {
  const token = new HmacConfirmationSigner(SECRET).sign({
    orgId: ORG,
    sub: SUB,
    listIds: [LIST],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return {
    queryStringParameters: { token },
    requestContext: { http: { method: "GET", sourceIp: "203.0.113.7" } },
  };
}

test("confirming a signup starts the list's drip sequence", async () => {
  const starter = new CaptureStarter();
  const res = await api.confirmHandler(confirmEvent(), { starter });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { status: "confirmed", confirmed: 1 });

  assert.equal(starter.started.length, 1, "the confirmation must enroll");
  assert.deepEqual(starter.started[0], {
    orgId: ORG,
    sequenceId: "welcome",
    subscriberId: SUB,
    nextStepIndex: 0,
    // Step 0's own wait. The machine starts at the Wait (#201), so a sequence
    // whose first step is "three days after signup" must not fire at signup.
    nextWaitSeconds: 259_200,
    // The opt-in REQUEST time, which `confirmOptInAny` preserves — not the
    // confirmation time, which it re-stamps on every click.
    enrollmentId: REQUESTED_AT,
  });
});

test("a second click on the same link enrolls under the same identity", async () => {
  // The subscription is already `confirmed` by now and is re-written with a fresh
  // updatedAt/confirmedAt, so the handler cannot tell click 2 from click 1 — and
  // does not try. Identity comes from `requestedAt`, which does not move, so the
  // execution name is identical and Step Functions collapses the duplicate.
  const starter = new CaptureStarter();
  const first = await api.confirmHandler(confirmEvent(), { starter });
  const second = await api.confirmHandler(confirmEvent(), { starter });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(
    starter.started.map((e) => e.enrollmentId),
    [REQUESTED_AT, REQUESTED_AT],
    "both clicks must resolve to ONE enrollment identity",
  );
});

test("a starter failure does not fail the confirmation", async () => {
  // Two shapes of failure, both real. A thrown error is a Step Functions outage
  // or a missing IAM grant; the uninjected call is a missing
  // DRIP_STATE_MACHINE_ARN, which `env()` turns into a throw from inside the
  // route. Either one, unguarded, becomes `json(400, { error })` — an error page
  // for a confirmation that is already committed to DynamoDB, which the
  // subscriber cannot fix by clicking again because it already worked.
  const exploding: DripStarter = {
    start: async () => {
      throw new Error("states.amazonaws.com: AccessDeniedException");
    },
  };
  const thrown = await api.confirmHandler(confirmEvent(), { starter: exploding });
  assert.equal(thrown.statusCode, 200, "a broken starter must not 400 the confirmation");
  assert.deepEqual(JSON.parse(thrown.body), { status: "confirmed", confirmed: 1 });

  const unconfigured = await api.confirmHandler(confirmEvent());
  assert.equal(unconfigured.statusCode, 200, "a missing env var must not 400 it either");
  assert.doesNotMatch(unconfigured.body, /DRIP_STATE_MACHINE_ARN/);

  // And the confirmation is real, not merely reported: the stored subscription is
  // confirmed either way.
  const stores = new DynamoStores(TABLE);
  const stored = await stores.subscriptions.get(ORG, SUB, LIST);
  assert.equal(stored?.status, "confirmed");
  assert.equal(stored?.consent?.requestedAt, REQUESTED_AT, "provenance survives every click");
});
