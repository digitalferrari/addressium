/**
 * Service-level: `POST /drip-sequences/enroll`, the operator half of #245.
 *
 * This is the one enrollment path with no double opt-in in front of it — an
 * operator names a subscriber and a sequence, and real marketing mail starts
 * going out. It arrived with a route-parity assertion (the key exists in both the
 * CDK and the router table, which an empty handler body satisfies) and a template
 * assertion (AdminApiFn has the ARN and the grant), and nothing that invoked it.
 * So its authorization check, its consent check and its 400s were unexercised: you
 * could delete `requireGrant` and the suite stayed green.
 *
 * Driven through the exported handler against a real DynamoDB API (dynalite) with
 * real `DynamoStores`, only the Step Functions client swapped.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import type { DripSequence, Subscriber, Subscription } from "@addressium/core";
import { DynamoStores } from "@addressium/adapters-aws";
import type { DripEnrollment, DripStarter } from "@addressium/domain";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-drip-enroll";
const ORG = "summit";
const LIST = "ledger";
const SUB = "s1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let api: typeof import("@addressium/svc-api");

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

  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint;
  process.env.AWS_REGION ??= "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "local";
  process.env.AWS_SECRET_ACCESS_KEY = "local";
  process.env.TABLE_NAME = TABLE;
  // Deliberately no DRIP_STATE_MACHINE_ARN: every test here injects a starter, and
  // the last one asserts what an unauthorized caller gets BEFORE anything reads it.

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
  const confirmed: Subscription = {
    orgId: ORG,
    subscriberId: SUB,
    listId: LIST,
    status: "confirmed",
    updatedAt: "2027-03-02T10:00:00.000Z",
    consent: { requestedAt: "2027-03-01T09:00:00.000Z", confirmedAt: "2027-03-02T10:00:00.000Z", basis: "explicit" },
  };
  // A second subscriber who never confirmed anything — the consent check's subject.
  const stranger: Subscriber = { ...subscriber, sub: "s2", email: "stranger@example.com" };
  const manual: DripSequence = {
    orgId: ORG,
    sequenceId: "onboarding",
    name: "Onboarding",
    trigger: { kind: "manual" },
    steps: [{ stepId: "day1", waitSeconds: 86_400, listId: LIST, templateId: "t", subject: "Hello" }],
  };
  const signup: DripSequence = {
    orgId: ORG,
    sequenceId: "welcome",
    name: "Welcome",
    trigger: { kind: "signup", listId: LIST },
    steps: [{ stepId: "day3", waitSeconds: 259_200, listId: LIST, templateId: "t", subject: "Welcome" }],
  };
  await stores.subscribers.put(subscriber);
  await stores.subscribers.put(stranger);
  await stores.subscriptions.put(confirmed);
  await stores.dripSequences.put(manual);
  await stores.dripSequences.put(signup);

  api = await import("@addressium/svc-api");
});

after(() => server?.close());

/** A POST event, authorized as `role` unless told otherwise. */
function enrollEvent(body: Record<string, unknown>, role = "developer_admin", orgs = ORG) {
  return {
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "POST", sourceIp: "203.0.113.7" },
      authorizer: { jwt: { claims: { "custom:role": role, "custom:orgs": orgs, sub: "admin-1" } } },
    },
  };
}

test("an authorized enrollment starts one execution and defaults its idempotency key", async () => {
  const starter = new CaptureStarter();
  const res = await api.dripEnrollHandler(
    enrollEvent({ orgId: ORG, sequenceId: "onboarding", subscriberId: SUB }),
    { starter },
  );

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as DripEnrollment;
  assert.equal(body.orgId, ORG);
  assert.equal(body.sequenceId, "onboarding");
  assert.equal(body.subscriberId, SUB);
  assert.equal(body.nextStepIndex, 0);
  assert.equal(body.nextWaitSeconds, 86_400, "step 0's OWN wait — the machine starts at the Wait (#201)");
  // Absent from the request, the handler stamps the instant: a deliberate operator
  // action is not a subscriber's accidental retry, so two clicks are two
  // enrollments unless the caller supplies a key.
  assert.match(body.enrollmentId, /^manual\.\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(starter.started, [body], "the response is what was started, exactly");
});

test("a caller-supplied enrollmentId is what makes a second click one enrollment", async () => {
  const starter = new CaptureStarter();
  const body = { orgId: ORG, sequenceId: "onboarding", subscriberId: SUB, enrollmentId: "batch-2027-03" };
  const first = await api.dripEnrollHandler(enrollEvent(body), { starter });
  const second = await api.dripEnrollHandler(enrollEvent(body), { starter });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(
    starter.started.map((e) => e.enrollmentId),
    ["batch-2027-03", "batch-2027-03"],
    "both calls carry ONE identity, so Step Functions collapses them by name",
  );
});

test("the route is gated on campaigns:manage", async () => {
  // Enrolling somebody starts a sequence of real sends to them. Without this check
  // any caller who reached the route could aim mail at an arbitrary subscriberId in
  // an arbitrary org — and nothing else in the suite exercises it.
  const starter = new CaptureStarter();
  for (const role of ["analyst", "support"]) {
    const res = await api.dripEnrollHandler(
      enrollEvent({ orgId: ORG, sequenceId: "onboarding", subscriberId: SUB }, role),
      { starter },
    );
    assert.equal(res.statusCode, 403, `${role} must not be able to enroll`);
  }
  // An editor has campaigns:manage, so it is allowed — asserted so the widening is
  // deliberate and visible rather than incidental (see the RBAC note in #245).
  const editor = await api.dripEnrollHandler(
    enrollEvent({ orgId: ORG, sequenceId: "onboarding", subscriberId: SUB, enrollmentId: "editor-1" }, "editor"),
    { starter },
  );
  assert.equal(editor.statusCode, 200);

  // ...and scope still binds: the same role in another org is refused.
  const wrongOrg = await api.dripEnrollHandler(
    enrollEvent({ orgId: ORG, sequenceId: "onboarding", subscriberId: SUB }, "developer_admin", "other"),
    { starter },
  );
  assert.equal(wrongOrg.statusCode, 403);

  // No claims at all — the shape an unauthenticated caller arrives in.
  const anonymous = await api.dripEnrollHandler(
    { body: JSON.stringify({ orgId: ORG, sequenceId: "onboarding", subscriberId: SUB }) },
    { starter },
  );
  assert.equal(anonymous.statusCode, 403);

  assert.deepEqual(
    starter.started.map((e) => e.enrollmentId),
    ["editor-1"],
    "only the authorized call may reach the starter",
  );
});

test("a signup-triggered, unknown, or malformed sequence is a 400, not a silence", async () => {
  const starter = new CaptureStarter();
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    // Hand-starting a signup sequence would run it alongside the subscriber's real
    // enrollment, under a second claim namespace: every step delivered twice.
    [{ orgId: ORG, sequenceId: "welcome", subscriberId: SUB }, /signup-triggered, not manual/],
    [{ orgId: ORG, sequenceId: "nope", subscriberId: SUB }, /unknown drip sequence/],
    // The consent check: this subscriber never confirmed the list step 0 mails.
    [{ orgId: ORG, sequenceId: "onboarding", subscriberId: "s2" }, /no confirmed subscription to ledger/],
    [{ orgId: ORG, sequenceId: "onboarding" }, /subscriberId/],
  ];
  for (const [body, expected] of cases) {
    const res = await api.dripEnrollHandler(enrollEvent(body), { starter });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.match(JSON.parse(res.body).error, expected);
  }
  assert.deepEqual(starter.started, [], "nothing may be started by a rejected request");
});

test("a starter failure is reported, not swallowed", async () => {
  // The opposite posture to the confirmation path, deliberately: there the
  // confirmation is already durable and enrollment is best-effort, but an operator
  // who clicks "Enroll" is owed an answer.
  const exploding: DripStarter = {
    start: async () => {
      throw new Error("states.amazonaws.com: AccessDeniedException");
    },
  };
  const res = await api.dripEnrollHandler(
    enrollEvent({ orgId: ORG, sequenceId: "onboarding", subscriberId: SUB }),
    { starter: exploding },
  );
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /AccessDeniedException/);
});
