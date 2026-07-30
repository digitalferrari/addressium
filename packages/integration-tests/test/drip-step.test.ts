/**
 * Service-level: the real `dripStepHandler`, which is the half of #245 that runs
 * INSIDE the state machine.
 *
 * #245 was a pure function with no caller. The obvious way to reintroduce it is to
 * test the new pure functions and not the handler that calls them — and this
 * handler carries two things that only exist to be consumed by something else, so
 * neither has a unit test to hide behind:
 *
 *   - the `enrollmentId` echo, which the machine reads back with
 *     `JsonPath.stringAt("$.enrollmentId")` after the Task overwrites the state.
 *     Drop it and every multi-step sequence sends step 0 and then dies with a
 *     `States.Runtime` error on the second transition.
 *   - `dripCampaignId`, which namespaces the permanent send claim per enrollment.
 *     Revert it and a re-subscriber's second run finds every claim burned by the
 *     first and emails them nothing at all (#207, one automation over).
 *
 * So this drives the exported handler against a real DynamoDB API (dynalite) and
 * the real `SesEmailSender` over the wire, with only the far end of SES local — the
 * same posture as `scripts/dev-aws-stubs.mjs`, and for the same reason: the message
 * tags are built in the adapter, and the adapter is where the tag has to be legal.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import type { DripSequence, List, Organization, Subscriber, Subscription, Template } from "@addressium/core";
import { DynamoStores, SES_TAG, decodeTag } from "@addressium/adapters-aws";
import { dripCampaignId } from "@addressium/domain";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-drip-step";
const ORG = "summit";
const LIST = "ledger";
const SUB = "s1";
const SEQ = "welcome";
/** The enrollment identity of the run under test — a subscriber's opt-in request. */
const R1 = "2027-03-01T09:00:00.000Z";
/** A later re-subscribe. Same subscriber, same sequence, different enrollment. */
const R2 = "2028-01-05T08:00:00.000Z";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dyn: any;
let ses: Server;
let shim: Server;
/** Every message SES was asked to send, in order. */
let outbox: Array<{ subject?: string; tags: Array<{ Name: string; Value: string }> }>;
let stores: DynamoStores;
let automations: typeof import("@addressium/svc-automations");

/** The campaign id SES was told, decoded back out of its base64url tag. */
const campaignTags = (): string[] =>
  outbox.map((m) => decodeTag(m.tags.find((t) => t.Name === SES_TAG.campaign)?.Value ?? ""));

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });

/** Host+port from the upstream base URL, so a request PATH can never change it. */
function upstreamTarget(upstream: string): { hostname: string; port: string } {
  const u = new URL(upstream);
  return { hostname: u.hostname, port: u.port };
}

/**
 * dynalite, with the one answer dynalite cannot give.
 *
 * `events.append` writes the event row and bumps the campaign counter in ONE
 * `TransactWriteItems` (#221), and dynalite implements that action not at all —
 * `DynamoStores` has a test-only constructor flag for exactly this, which is no
 * use here because the handler builds its own stores from `TABLE_NAME`. So the
 * SDK is pointed at this shim instead: everything is forwarded to dynalite
 * verbatim, and a `TransactWriteItems` gets back the `TransactionCanceledException`
 * that REAL DynamoDB returns for this input — `[None, ConditionalCheckFailed]`,
 * because a drip sub-campaign id has no CAMPAIGN item for the counter Update's
 * `attribute_exists` guard to find. The adapter's documented fallback then writes
 * the event row with a plain Put, for real, against dynalite
 * (see dynamo-append-fallback.test.ts for that path on its own).
 *
 * A 200 would have been shorter and a lie — the send path would appear to record
 * events transactionally when nothing had been written at all.
 */
function startDynamoShim(upstream: string): Promise<Server> {
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (String(req.headers["x-amz-target"] ?? "").endsWith(".TransactWriteItems")) {
      res.writeHead(400, { "content-type": "application/x-amz-json-1.0" });
      res.end(
        JSON.stringify({
          __type: "com.amazonaws.dynamodb.v20120810#TransactionCanceledException",
          message: "Transaction cancelled, please refer cancellation reasons for specific reasons",
          CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
        }),
      );
      return;
    }
    const fwd = httpRequest(
      {
        // Host and port come from `upstream`; the request's path is passed as a
        // PATH and can never alter the authority. Concatenating them into a URL
        // string let `@evil.example` reparse the host out from under us — a real
        // SSRF shape even though this shim only ever hears from a local SDK
        // client (CodeQL #33/#34).
        ...upstreamTarget(upstream),
        path: req.url ?? "/",
        method: req.method,
        headers: { ...req.headers, "content-length": String(Buffer.byteLength(body)) },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 500, up.headers);
        up.pipe(res);
      },
    );
    fwd.end(body);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

before(async () => {
  dyn = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => dyn.listen(0, r));
  const dynEndpoint = `http://127.0.0.1:${(dyn.address() as AddressInfo).port}`;

  outbox = [];
  ses = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      outbox.push({ subject: msg.Content?.Simple?.Subject?.Data, tags: msg.EmailTags ?? [] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ MessageId: `m${outbox.length}` }));
    });
  });
  await new Promise<void>((r) => ses.listen(0, () => r()));

  // The HANDLER talks to the shim (it needs a TransactWriteItems answer); this
  // file's own seeding talks to dynalite directly, below.
  shim = await startDynamoShim(dynEndpoint);
  process.env.AWS_ENDPOINT_URL_DYNAMODB = `http://127.0.0.1:${(shim.address() as AddressInfo).port}`;
  process.env.AWS_ENDPOINT_URL_SESV2 = `http://127.0.0.1:${(ses.address() as AddressInfo).port}`;
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
    endpoint: dynEndpoint,
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

  stores = new DynamoStores(TABLE, client);
  const org: Organization = {
    orgId: ORG,
    name: "Summit",
    domains: ["northwindtimes.example"],
    sesConfigSet: "cs-summit",
    ipMode: "shared",
    suppressionScope: "org",
    defaultTimezone: "UTC",
    setupComplete: true,
  };
  const list: List = {
    orgId: ORG,
    listId: LIST,
    name: "The Ledger",
    optInPolicy: "double",
    fromAddress: "ledger@northwindtimes.example",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "1 Main St",
  };
  const subscriber: Subscriber = {
    orgId: ORG,
    sub: SUB,
    email: "reader@example.com",
    attributes: {},
    status: "active",
    entitlement: "free",
  };
  const template: Template = {
    orgId: ORG,
    templateId: "t",
    name: "Welcome",
    mode: "raw_html",
    source: "<p>hello</p>",
    version: 1,
    mergeTags: [],
    adSlots: [],
  };
  const sequence: DripSequence = {
    orgId: ORG,
    sequenceId: SEQ,
    name: "Welcome",
    trigger: { kind: "signup", listId: LIST },
    steps: [
      { stepId: "day3", waitSeconds: 259_200, listId: LIST, templateId: "t", subject: "Welcome" },
      { stepId: "day4", waitSeconds: 86_400, listId: LIST, templateId: "t", subject: "More" },
    ],
  };
  await stores.organizations.put(org);
  await stores.lists.put(list);
  await stores.subscribers.put(subscriber);
  await stores.templates.put(template);
  await stores.dripSequences.put(sequence);

  automations = await import("@addressium/svc-automations");
});

after(() => {
  dyn?.close();
  ses?.close();
  shim?.close();
});

/** Put the list subscription in a given state, with a given opt-in request time. */
const setSubscription = (status: Subscription["status"], requestedAt = R1) =>
  stores.subscriptions.put({
    orgId: ORG,
    subscriberId: SUB,
    listId: LIST,
    status,
    updatedAt: "2027-03-02T10:00:00.000Z",
    consent: { requestedAt, confirmedAt: "2027-03-02T10:00:00.000Z", basis: "explicit" },
  });

const step = (over: Record<string, unknown> = {}) =>
  automations.dripStepHandler({
    orgId: ORG,
    sequenceId: SEQ,
    subscriberId: SUB,
    stepIndex: 0,
    enrollmentId: R1,
    ...over,
  });

test("a step echoes the routing identity the machine loops on, enrollment token included", async () => {
  await setSubscription("confirmed");
  const out = await step();

  // The Task has `outputPath: "$.Payload"`, so this return value IS the machine's
  // next state. Every field the definition reads by JSONPath has to be in it: drop
  // `enrollmentId` and iteration 2 resolves `$.enrollmentId` against an object that
  // no longer has one, which is a States.Runtime failure — a sequence that sends
  // step 0 and then fails, with nothing in any test to notice.
  assert.deepEqual(out, {
    orgId: ORG,
    sequenceId: SEQ,
    subscriberId: SUB,
    enrollmentId: R1,
    done: false,
    action: "send",
    nextStepIndex: 1,
    nextWaitSeconds: 86_400,
  });
  assert.equal(outbox.length, 1, "and it sent the step");
});

test("an execution started before enrollment ids echoes a string, never null", async () => {
  // `JsonPath.stringAt` onto a null is a States.Runtime failure exactly like a
  // missing field, so an in-flight pre-#245 execution has to loop on "" instead.
  await setSubscription("confirmed");
  const out = (await step({ enrollmentId: undefined, stepIndex: 1 })) as { enrollmentId: unknown };
  assert.equal(out.enrollmentId, "");
});

test("each enrollment claims its sends under its own namespace (#207, one automation over)", async () => {
  // The claim is a permanent conditional Put with no TTL. Under the old
  // `drip-<seq>-<step>` key it was burned by the first run for good, so a
  // subscriber who left and came back started a real execution that marched
  // through every step finding the claim taken and emailed them nothing.
  // Its own pair of enrollment identities, because the claim from any earlier test
  // in this file is permanent — which is the property under test.
  const first = "2027-04-01T09:00:00.000Z";
  const second = "2027-05-01T09:00:00.000Z";
  await setSubscription("confirmed", first);
  outbox.length = 0;

  await step({ stepIndex: 0, enrollmentId: first });
  assert.deepEqual(campaignTags(), [dripCampaignId(SEQ, "day3", first)]);
  assert.deepEqual(campaignTags(), [`drip:${SEQ}#${first}#day3`], "the id shape, pinned");

  // Same enrollment, same step: the claim holds, so a retried Task cannot double-send.
  await step({ stepIndex: 0, enrollmentId: first });
  assert.equal(outbox.length, 1, "a retry within one enrollment must not re-send");

  // A genuine re-subscribe is a different enrollment and must be mailed again.
  await setSubscription("confirmed", second);
  await step({ stepIndex: 0, enrollmentId: second });
  assert.deepEqual(campaignTags(), [`drip:${SEQ}#${first}#day3`, `drip:${SEQ}#${second}#day3`]);
});

test("the campaign id SES is handed is always a legal message tag", async () => {
  // A manual enrollment's id is operator-supplied, up to 128 characters
  // (`enrollDripSequenceSchema`). SES caps a message-tag value at 256 characters of
  // base64url — four characters per three bytes — so an unbounded id is a
  // ValidationException on every send of the sequence, days after the enrollment
  // returned 200. The id is digested past the budget instead.
  const long = `manual.${"k".repeat(121)}`;
  await setSubscription("confirmed", long);
  outbox.length = 0;

  const out = (await step({ stepIndex: 1, enrollmentId: long })) as { action: string };
  assert.equal(out.action, "send");
  const tag = outbox[0]!.tags.find((t) => t.Name === SES_TAG.campaign)!.Value;
  assert.ok(tag.length <= 256, `SES rejects a tag value over 256 characters, got ${tag.length}`);
  assert.match(tag, /^[A-Za-z0-9_-]+$/);
  assert.equal(decodeTag(tag), dripCampaignId(SEQ, "day4", long));
});

test("a step will not send to a subscription that is not confirmed", async () => {
  // `mayMail` checks the subscriber's org status and the suppression list and never
  // the list subscription — every other marketing path resolves its recipients FROM
  // the list, so this handler, handed a bare subscriberId by the machine, is the
  // only place that can ask. It used to exit only on unsubscribed/bounced, so a
  // `pending` subscriber was mailed before finishing double opt-in.
  await setSubscription("pending");
  outbox.length = 0;

  const out = (await step({ stepIndex: 1 })) as { done: boolean; action: string; reason: string };
  assert.equal(out.action, "exit");
  assert.equal(out.done, true);
  assert.match(out.reason, /subscription pending/);
  assert.equal(outbox.length, 0, "no marketing mail without a confirmed opt-in");
});

test("a newer enrollment retires the execution that is still running", async () => {
  // Day 0: confirm, execution A starts under R1. Day 2: the subscriber re-submits
  // the signup form and confirms, so `requestedAt` moves to R2 and execution B
  // starts. A cannot be cancelled from outside — nothing remembers its name — and
  // its claims no longer collide with B's, so left running BOTH would deliver every
  // remaining step. A therefore retires itself at its next step.
  await setSubscription("confirmed", R2);
  outbox.length = 0;

  const stale = (await step({ stepIndex: 1, enrollmentId: R1 })) as {
    done: boolean;
    action: string;
    reason: string;
    enrollmentId: string;
  };
  assert.equal(stale.action, "exit");
  assert.equal(stale.done, true);
  assert.match(stale.reason, /superseded by a newer enrollment/);
  assert.equal(stale.enrollmentId, R1, "and it still echoes its own identity");
  assert.equal(outbox.length, 0, "the stale execution must not send");

  // The current enrollment carries on — this is not a global stop.
  const live = (await step({ stepIndex: 1, enrollmentId: R2 })) as { action: string };
  assert.equal(live.action, "send");
  assert.equal(outbox.length, 1);
});
