/**
 * The three SES event types that used to be silently dropped (#241).
 *
 * `Reject`, `Rendering Failure` and `DeliveryDelay` were in SES's feed the whole
 * time and none was in `ACTIONABLE`, so `normalize` returned undefined and the
 * handler acknowledged them as unresolvable. Nothing failed; the information just
 * did not exist.
 *
 * Every payload here is a RAW SES notification wrapped the way SNS→SQS actually
 * delivers it — the shape #241 asks for explicitly, because a pre-digested
 * `Notification` would test our own type rather than SES's wire format. In
 * particular `Rendering Failure` carries a SPACE in the event type and spells its
 * detail key `failure`, both of which a normalizing transform would get wrong.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoStores, SES_TAG, encodeTag, normalize } from "@addressium/adapters-aws";
import { deriveCounters } from "@addressium/domain";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-ses-outcomes";
const ORG = "summit";
const CAMPAIGN = "issue-42";
const SUB = "sub-1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let shim: Server;
let client: DynamoDBClient;
let events: typeof import("@addressium/svc-events");

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });

/** Host+port from the upstream base URL, so a request PATH can never change it. */
function upstreamTarget(upstream: string): { hostname: string; port: string } {
  const u = new URL(upstream);
  return { hostname: u.hostname, port: u.port };
}

/**
 * dynalite plus the one answer it cannot give.
 *
 * `events.append` writes the event row and bumps the campaign counter in ONE
 * `TransactWriteItems` (#221), and dynalite implements that action not at all.
 * `DynamoStores` has a test-only flag for exactly this, which is no use here
 * because the HANDLER builds its own stores from `TABLE_NAME` — so the SDK is
 * pointed at this shim instead. Everything is forwarded to dynalite verbatim, and
 * a `TransactWriteItems` gets back the `TransactionCanceledException` REAL
 * DynamoDB returns for this input: `[None, ConditionalCheckFailed]`, because
 * these campaign ids have no CAMPAIGN record for the counter Update's
 * `attribute_exists` guard to find. The adapter's documented fallback then writes
 * the event row with a plain Put, for real, against dynalite.
 *
 * A 200 would have been shorter and a lie — the handler would appear to record
 * events transactionally when nothing had been written at all. Same shim as
 * drip-step.test.ts, same reason.
 */
function startDynamoShim(upstream: string): Promise<Server> {
  const srv = createServer(async (req, res) => {
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
  return new Promise((r) => srv.listen(0, () => r(srv)));
}

/** The `mail` block SES puts on every event, carrying our correlation tags. */
const mail = (messageId = "0100018f-msg") => ({
  messageId,
  timestamp: "2026-07-30T12:00:00.000Z",
  destination: ["reader@example.com"],
  tags: {
    [SES_TAG.org]: [encodeTag(ORG)],
    [SES_TAG.campaign]: [encodeTag(CAMPAIGN)],
    [SES_TAG.subscriber]: [encodeTag(SUB)],
  },
});

/** One raw SES notification, wrapped as SQS delivers it (raw message delivery). */
const sqsEvent = (...notifications: Record<string, unknown>[]) => ({
  Records: notifications.map((n, i) => ({
    messageId: `sqs-${i}`,
    body: JSON.stringify(n),
  })),
});

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The HANDLER talks to the shim (it needs a TransactWriteItems answer); the
  // assertions below read through `client`, which goes straight to dynalite.
  shim = await startDynamoShim(endpoint);
  process.env.AWS_ENDPOINT_URL_DYNAMODB = `http://127.0.0.1:${(shim.address() as AddressInfo).port}`;
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
  events = await import("@addressium/svc-events");
});

after(() => {
  shim?.close();
  server?.close();
});

// ---------------------------------------------------------------------------
// Parsing — the raw wire shapes
// ---------------------------------------------------------------------------

test("a raw Reject notification resolves, carrying SES's reason", () => {
  const n = normalize({
    eventType: "Reject",
    mail: mail(),
    reject: { reason: "Bad content" },
  });
  assert.equal(n?.eventType, "Reject");
  assert.equal(n?.orgId, ORG);
  assert.equal(n?.campaignId, CAMPAIGN);
  assert.equal(n?.subscriberId, SUB);
  assert.equal(n?.reason, "Bad content");
  // Not a bounce classification — nothing may read this as suppressible.
  assert.equal(n?.bounceType, undefined);
});

test("Rendering Failure resolves despite the space in its name and the `failure` key", () => {
  // Two ways to get this wrong, both silent: normalizing the space away (so the
  // lookup misses) and reading a `renderingFailure` key that SES does not send.
  const n = normalize({
    eventType: "Rendering Failure",
    mail: mail(),
    failure: { errorMessage: "Attribute 'first_name' is not present", templateName: "welcome-v3" },
  });
  assert.equal(n?.eventType, "RenderingFailure");
  assert.equal(n?.reason, "Attribute 'first_name' is not present");
  assert.equal(n?.templateName, "welcome-v3", "the operator needs to know WHICH template");
});

test("DeliveryDelay resolves with its delay classification and own timestamp", () => {
  const n = normalize({
    eventType: "DeliveryDelay",
    mail: mail(),
    deliveryDelay: {
      delayType: "MailboxFull",
      expirationTime: "2026-07-31T12:00:00.000Z",
      timestamp: "2026-07-30T12:30:00.000Z",
    },
  });
  assert.equal(n?.eventType, "DeliveryDelay");
  assert.equal(n?.delayType, "MailboxFull");
});

test("two delays of one message stay distinct; a redelivery of one collapses", () => {
  const first = normalize({
    eventType: "DeliveryDelay",
    mail: mail(),
    deliveryDelay: { timestamp: "2026-07-30T12:30:00.000Z" },
  });
  const again = normalize({
    eventType: "DeliveryDelay",
    mail: mail(),
    deliveryDelay: { timestamp: "2026-07-30T12:30:00.000Z" },
  });
  const later = normalize({
    eventType: "DeliveryDelay",
    mail: mail(),
    deliveryDelay: { timestamp: "2026-07-30T18:00:00.000Z" },
  });
  // A receiver deferring the same message twice is two signals about that
  // receiver; SNS handing us one notification twice is one.
  assert.equal(first?.eventId, again?.eventId);
  assert.notEqual(first?.eventId, later?.eventId);
});

test("a Reject and a Delivery for the same message do not share an eventId", () => {
  // Both fall back to `mail.timestamp` (neither carries its own), so the event
  // TYPE has to be part of the hash or one would overwrite the other's row.
  const reject = normalize({ eventType: "Reject", mail: mail("same-id"), reject: {} });
  const delivery = normalize({ eventType: "Delivery", mail: mail("same-id") });
  assert.ok(reject?.eventId && delivery?.eventId);
  assert.notEqual(reject.eventId, delivery.eventId);
});

test("the two types still dropped are dropped deliberately", () => {
  // `Subscription`: we never enable SES's own subscription page — unsubscribe is
  // RFC 8058 through our handler (§4.4) — so an event about a preference we do not
  // honour would write a row nothing reads.
  assert.equal(normalize({ eventType: "Subscription", mail: mail() }), undefined);
  // `Send`: the send path writes its own `sent` event per recipient, which is the
  // one available while a send is still in flight. Consuming SES's copy as well
  // would double every `sent` counter in the product — and `sent` is the
  // denominator of every rate in `deliverabilityRates`, so it would halve all of
  // them at once.
  assert.equal(normalize({ eventType: "Send", mail: mail() }), undefined);
});

// ---------------------------------------------------------------------------
// The handler — what each one does to the counters
// ---------------------------------------------------------------------------

test("all three are recorded, and none of them suppresses", async () => {
  const res = await events.handler(
    sqsEvent(
      { eventType: "Reject", mail: mail("m-reject"), reject: { reason: "Bad content" } },
      {
        eventType: "Rendering Failure",
        mail: mail("m-render"),
        failure: { errorMessage: "no such attribute", templateName: "welcome-v3" },
      },
      { eventType: "DeliveryDelay", mail: mail("m-delay"), deliveryDelay: { delayType: "MailboxFull" } },
    ),
  );
  assert.deepEqual((res as { batchItemFailures: unknown[] }).batchItemFailures, []);

  const stores = new DynamoStores(TABLE, client);
  const rows = await stores.events.all(ORG, CAMPAIGN);
  const types = rows.map((r: { type: string }) => r.type).sort();
  assert.deepEqual(types, ["delivery_delay", "reject", "rendering_failure"]);

  const counters = deriveCounters(rows);
  assert.equal(counters.rejects, 1);
  assert.equal(counters.renderingFailures, 1);
  assert.equal(counters.deliveryDelays, 1);

  // The load-bearing negatives. A reject is OUR content, not the recipient's
  // mailbox; a delay is transient by definition. Suppressing on either kills a
  // valid subscriber GLOBALLY (§4.13) for something that was never their fault —
  // the #211 mistake, two event types over.
  assert.equal(await stores.suppression.isSuppressed(ORG, "reader@example.com"), false);
  assert.equal(counters.bounces, 0, "none of the three may be counted as a bounce");
  assert.equal(counters.delivered, 0, "and none of them delivered anything");
});

test("a reject does not inflate the delivered count it is adjacent to", async () => {
  // #241's acceptance criterion. `sent - delivered - bounces - rejects` is how far
  // the send got, and it only works if the four stay separate.
  const stores = new DynamoStores(TABLE, client);
  const other = "issue-43";
  await events.handler(
    sqsEvent(
      { eventType: "Delivery", mail: { ...mail("d-1"), tags: mail().tags }, delivery: {} },
      { eventType: "Reject", mail: mail("r-1"), reject: { reason: "Bad content" } },
    ),
  );
  const rows = await stores.events.all(ORG, CAMPAIGN);
  const c = deriveCounters(rows);
  assert.equal(c.rejects, 2, "the reject from the previous test plus this one");
  assert.equal(c.delivered, 1, "exactly the one Delivery — the reject is not in here");
  assert.ok(other);
});

// ---------------------------------------------------------------------------
// The alarm literal — producer and filter must agree
// ---------------------------------------------------------------------------

test("the rendering-failure log line the alarm watches is the line we emit", () => {
  // A counter in a per-campaign report is read AFTER the send; the alarm fires
  // while it is still running, which is the only time the information helps. The
  // link between them is a string literal in two files, so a reworded log message
  // with no filter change would silently stop alarming — the genre of break no
  // other test in the suite can see.
  // Walk up rather than counting `..`: this file runs from `dist/test`, so a
  // fixed depth is right for the source tree and wrong for the compiled one.
  let root = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8 && !existsSync(resolve(root, "infra/cdk/lib/control-plane-stack.ts")); i++) {
    root = resolve(root, "..");
  }
  const handler = readFileSync(resolve(root, "services/events/src/index.ts"), "utf8");
  const stack = readFileSync(resolve(root, "infra/cdk/lib/control-plane-stack.ts"), "utf8");

  const LITERAL = "events: rendering failure";
  assert.ok(handler.includes(`console.error("${LITERAL}"`), "the handler no longer logs the literal");
  assert.ok(
    stack.includes(`FilterPattern.literal('"${LITERAL}"')`),
    "the MetricFilter no longer matches the literal",
  );
});
