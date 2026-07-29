/**
 * Regression test for the record-less-campaign transaction defect.
 *
 * appendEvent writes the event row and bumps the campaign counter in ONE
 * TransactWriteItems (#221). The counter Update carries
 * `ConditionExpression: attribute_exists(pk)` so an event can never resurrect
 * a campaign — but recurring editions (`<base>-<editionKey>`, feed.ts), drip
 * sub-campaigns and re-engagement steps send under ids that have NO CAMPAIGN
 * item, so the condition fails and the WHOLE transaction cancels, event row
 * included. The old catch handled only reasons[0] (exact redelivery) and
 * reasons[2] (repeat open/click), so a reasons[1] failure rethrew: the sender
 * threw AFTER SES had dispatched the mail, and SES bounce/complaint
 * notifications for edition campaigns threw in the events handler and cycled
 * to the events DLQ.
 *
 * The fix mirrors the memory store's documented semantic ("never resurrect a
 * campaign that does not exist", memory.ts): record the event, skip the
 * counter.
 *
 * This test stubs the `requestHandler` of a real DynamoDBClient (the document
 * client builds its own middleware stack over the client's config, so the
 * handler is the only reliable interception point). It cannot use dynalite —
 * dynalite implements no TransactWriteItems at all, which is exactly why the
 * defect was invisible to the integration suite (dynamo.ts:92-103).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { DynamoStores } from "@addressium/adapters-aws";
import type { EngagementEvent } from "@addressium/core";

const ORG = "summit";
/** The shape of a recurring-series edition id: no CAMPAIGN item exists for it. */
const EDITION = "daily-1-2026072713";

const evt = (type: EngagementEvent["type"]): EngagementEvent => ({
  orgId: ORG,
  subscriberId: "s001",
  campaignId: EDITION,
  type,
  at: "2026-07-29T04:00:00.000Z",
});

type Call = { kind: string; input?: Record<string, unknown> };

/**
 * A real client whose `requestHandler` is stubbed: every TransactWriteItems
 * gets a wire-level TransactionCanceledException (parsed by the real protocol
 * deserializer, so CancellationReasons arrive exactly as DynamoDB sends them),
 * every PutItem succeeds and is recorded. The document client talks to
 * `config.requestHandler`, not `client.send`, so this is the interception
 * point — it also exercises the real marshalling path end to end.
 */
function stubClient(reasons: { Code?: string }[] | null) {
  const calls: Call[] = [];
  const requestHandler = {
    handle: async (request: { headers: Record<string, string>; body?: unknown }) => {
      const target = request.headers["x-amz-target"] ?? "";
      const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
      if (target.endsWith(".TransactWriteItems")) {
        calls.push({ kind: "transact", input: JSON.parse(String(request.body)) as Record<string, unknown> });
        if (reasons === null) {
          return { response: { statusCode: 200, headers: {}, body: json({}) } };
        }
        return {
          response: {
            statusCode: 400,
            headers: {},
            body: json({
              __type: "com.amazonaws.dynamodb.v20120810#TransactionCanceledException",
              message: "Transaction cancelled",
              CancellationReasons: reasons,
            }),
          },
        };
      }
      if (target.endsWith(".PutItem")) {
        calls.push({ kind: "put", input: JSON.parse(String(request.body)) as Record<string, unknown> });
        return { response: { statusCode: 200, headers: {}, body: json({}) } };
      }
      throw new Error(`unexpected target: ${target}`);
    },
  };
  const client = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
    requestHandler: requestHandler as never,
  });
  return { client, calls };
}

/** The counter Update inside the first (and only) transact call. */
function counterUpdate(calls: Call[]) {
  const items = calls[0]?.input?.TransactItems as { Update?: Record<string, never> }[] | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return items?.[1]?.Update as any;
}

test("the counter Update targets the campaign RECORD's counters map", async () => {
  // Regression for the root defect: the Update used to Key on `CAMPAIGN#<id>`
  // — an item nothing ever writes — so attribute_exists failed for EVERY
  // campaign and no counter ever moved on real DynamoDB; and it wrote
  // `data.<field>` where readers expect `data.counters.<field>`.
  const { client, calls } = stubClient(null); // transaction succeeds
  const stores = new DynamoStores("addressium", client);

  await stores.events.append({ ...evt("bounce"), campaignId: "camp-1" });

  assert.deepEqual(calls.map((c) => c.kind), ["transact"], "success needs no fallback");
  const update = counterUpdate(calls);
  assert.equal(update.Key.pk.S, `ORG#${ORG}`);
  assert.equal(update.Key.sk.S, `CAMPAIGNREC#camp-1`);
  assert.equal(update.ExpressionAttributeNames["#cnt"], "counters");
  assert.ok(
    String(update.UpdateExpression).includes("#c.#cnt.#f"),
    "increments data.counters.<field>, not a phantom top-level attribute",
  );
});

test("bounce for a record-less edition id: event is kept, counter skipped, no throw", async () => {
  // reasons[0] = event Put (ok), reasons[1] = counter Update (no CAMPAIGN item).
  const { client, calls } = stubClient([{ Code: "None" }, { Code: "ConditionalCheckFailed" }]);
  const stores = new DynamoStores("addressium", client);

  await stores.events.append(evt("bounce")); // must not throw

  assert.deepEqual(calls.map((c) => c.kind), ["transact", "put"]);
  const item = calls[1]?.input?.Item as Record<string, { S: string }> | undefined;
  assert.ok(item, "the fallback PutItem carries the event row");
  assert.equal(item.pk?.S, `ORG#${ORG}#CAMPAIGN#${EDITION}`);
  assert.ok(item.sk?.S.startsWith("EVENT#"), "the fallback writes the event row");
});

test("open for a record-less edition id (unique-event path) falls back the same way", async () => {
  // open/click append a third item (the UNIQ marker) — its reason slot is [2].
  const { client, calls } = stubClient([
    { Code: "None" },
    { Code: "ConditionalCheckFailed" },
    { Code: "None" },
  ]);
  const stores = new DynamoStores("addressium", client);

  await stores.events.append(evt("open"));

  assert.deepEqual(calls.map((c) => c.kind), ["transact", "put"]);
});

test("repeat open where BOTH the marker exists and the campaign row is absent still records the event once", async () => {
  const { client, calls } = stubClient([
    { Code: "None" },
    { Code: "ConditionalCheckFailed" },
    { Code: "ConditionalCheckFailed" },
  ]);
  const stores = new DynamoStores("addressium", client);

  await stores.events.append(evt("open"));

  assert.deepEqual(calls.map((c) => c.kind), ["transact", "put"]);
});

test("exact redelivery stays a silent no-op even on a record-less id", async () => {
  // reasons[0] = the event row already exists: counters already moved (or were
  // already skipped) on the first delivery — nothing to do.
  const { client, calls } = stubClient([
    { Code: "ConditionalCheckFailed" },
    { Code: "ConditionalCheckFailed" },
  ]);
  const stores = new DynamoStores("addressium", client);

  await stores.events.append(evt("bounce"));

  assert.deepEqual(calls.map((c) => c.kind), ["transact"], "no fallback write on exact redelivery");
});

test("any OTHER cancellation reason still throws", async () => {
  const { client } = stubClient([{ Code: "None" }, { Code: "Throttling" }]);
  const stores = new DynamoStores("addressium", client);

  await assert.rejects(stores.events.append(evt("bounce")), TransactionCanceledException);
});
