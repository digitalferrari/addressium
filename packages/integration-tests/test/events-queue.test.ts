/**
 * Event-plane durability (#218, compendium #20/#44).
 *
 * SES events used to arrive SNS → Lambda, which is an ASYNCHRONOUS invocation:
 * AWS retries twice and then discards the event permanently. A discarded bounce
 * is an address that is never suppressed and keeps being mailed. They now arrive
 * SNS → SQS → Lambda, which means two things must hold:
 *
 *  1. The queue body must still resolve, whether or not raw message delivery is
 *     on — flipping that flag must not silently stop every event resolving.
 *  2. One poison event must fail on its own. Failing the batch would send its
 *     nine healthy peers back for redelivery, which is the defect #177 fixed on
 *     the send path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SES_TAG, encodeTag, normalize, unwrap, unwrapRecords } from "@addressium/adapters-aws";

const tags = {
  [SES_TAG.org]: [encodeTag("acme")],
  [SES_TAG.campaign]: [encodeTag("daily")],
  [SES_TAG.subscriber]: [encodeTag("s001")],
};

const bounce = (id = "m1") => ({
  eventType: "Bounce",
  mail: { messageId: id, timestamp: "2026-07-28T00:00:00.000Z", tags },
  bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@x.com" }] },
});

/** SQS delivery WITH raw message delivery — the body is the SES notification. */
const sqsRaw = (records: { id: string; inner: unknown }[]) => ({
  Records: records.map((r) => ({ messageId: r.id, body: JSON.stringify(r.inner) })),
});

/** SQS delivery WITHOUT raw message delivery — the body is the SNS envelope. */
const sqsWrapped = (records: { id: string; inner: unknown }[]) => ({
  Records: records.map((r) => ({
    messageId: r.id,
    body: JSON.stringify({ Type: "Notification", MessageId: r.id, Message: JSON.stringify(r.inner) }),
  })),
});

test("unwrapRecords keeps each payload paired with its SQS messageId", () => {
  const out = unwrapRecords(sqsRaw([{ id: "aaa", inner: bounce("m1") }, { id: "bbb", inner: bounce("m2") }]));
  assert.equal(out.length, 2);
  assert.equal(out[0]?.messageId, "aaa");
  assert.equal(out[1]?.messageId, "bbb");
  // Without the id there is nothing to report as a partial failure, so the
  // whole batch would have to fail together.
  assert.ok(out.every((r) => typeof r.messageId === "string"));
});

test("a raw-delivery body resolves to a notification", () => {
  const [rec] = unwrapRecords(sqsRaw([{ id: "aaa", inner: bounce() }]));
  const notif = normalize(rec?.payload);
  assert.equal(notif?.eventType, "Bounce");
  assert.equal(notif?.orgId, "acme");
  assert.equal(notif?.subscriberId, "s001");
});

test("an SNS-enveloped body resolves identically — flipping rawMessageDelivery cannot break resolution", () => {
  const [rec] = unwrapRecords(sqsWrapped([{ id: "aaa", inner: bounce() }]));
  const notif = normalize(rec?.payload);
  assert.equal(notif?.eventType, "Bounce", "the SNS envelope must be peeled too");
  assert.equal(notif?.orgId, "acme");
  assert.equal(notif?.subscriberId, "s001");
});

test("both delivery shapes produce the same notification", () => {
  const raw = normalize(unwrapRecords(sqsRaw([{ id: "a", inner: bounce() }]))[0]?.payload);
  const wrapped = normalize(unwrapRecords(sqsWrapped([{ id: "a", inner: bounce() }]))[0]?.payload);
  assert.deepEqual(raw, wrapped);
});

test("the SNS→Lambda shape still resolves, so a replay of an old-format event works", () => {
  const [rec] = unwrapRecords({ Records: [{ Sns: { Message: JSON.stringify(bounce()) } }] });
  assert.equal(normalize(rec?.payload)?.eventType, "Bounce");
  assert.equal(rec?.messageId, undefined, "an SNS record carries no SQS receipt");
});

test("a non-JSON body is dropped, not failed — retrying cannot fix malformed JSON", () => {
  const out = unwrapRecords({ Records: [{ messageId: "a", body: "not json" }, { messageId: "b", body: JSON.stringify(bounce()) }] });
  assert.equal(out.length, 1, "the bad record is skipped");
  assert.equal(out[0]?.messageId, "b", "its healthy peer survives");
});

test("an envelope whose inner Message is not JSON falls back rather than throwing", () => {
  const out = unwrapRecords({
    Records: [{ messageId: "a", body: JSON.stringify({ Type: "Notification", Message: "not json" }) }],
  });
  assert.equal(out.length, 1);
  assert.equal(normalize(out[0]?.payload), undefined, "unresolvable, but it did not throw");
});

test("unwrap still returns payloads only, for direct-invoke callers", () => {
  const inner = bounce();
  assert.deepEqual(unwrap({ Records: [{ Sns: { Message: JSON.stringify(inner) } }] }), [inner]);
  const direct = { eventType: "Open", orgId: "acme" };
  assert.deepEqual(unwrap(direct), [direct]);
});

test("a mixed batch yields exactly the resolvable records", () => {
  const out = unwrapRecords(
    sqsRaw([
      { id: "a", inner: bounce("m1") },
      { id: "b", inner: { eventType: "Rendering Failure" } },
      { id: "c", inner: bounce("m2") },
    ]),
  );
  assert.equal(out.length, 3, "all three parse");
  const resolved = out.map((r) => normalize(r.payload)).filter(Boolean);
  assert.equal(resolved.length, 2, "only the two bounces resolve to notifications");
});
