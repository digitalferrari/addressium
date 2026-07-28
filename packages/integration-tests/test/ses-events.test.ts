/**
 * Regression (#184): the events handler read `notif.eventType` off the top
 * level, but SNS delivers `{Records:[{Sns:{Message:"<json>"}}]}`. Every SES
 * event therefore fell through every branch and returned `{ok:true}` — bounces
 * and complaints were NEVER processed, silently, with no alarm.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { unwrap, normalize, SES_TAG, encodeTag } from "@addressium/adapters-aws";

const tags = {
  [SES_TAG.org]: [encodeTag("acme")],
  [SES_TAG.campaign]: [encodeTag("daily#ab-A")], // "#" is why tags are base64url
  [SES_TAG.subscriber]: [encodeTag("s001")],
};

/** A realistic SES-via-SNS delivery. */
function snsEvent(inner: unknown) {
  return { Records: [{ Sns: { Message: JSON.stringify(inner) } }] };
}

test("unwrap peels the SNS envelope", () => {
  const inner = { eventType: "Bounce", mail: { tags } };
  assert.deepEqual(unwrap(snsEvent(inner)), [inner]);
});

test("unwrap passes through a direct payload and skips non-JSON bodies", () => {
  const direct = { eventType: "Open", orgId: "acme" };
  assert.deepEqual(unwrap(direct), [direct]);
  assert.deepEqual(unwrap({ Records: [{ Sns: { Message: "not json" } }] }), []);
});

test("a bounce arriving over SNS resolves to a subscriber", () => {
  const [inner] = unwrap(
    snsEvent({
      eventType: "Bounce",
      mail: { messageId: "0100abc", destination: ["r@x.example"], tags },
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "r@x.example" }],
      },
    }),
  );
  const n = normalize(inner);
  assert.ok(n, "must resolve — this returned undefined behaviour before the fix");
  assert.equal(n.eventType, "Bounce");
  assert.equal(n.orgId, "acme");
  assert.equal(n.campaignId, "daily#ab-A", "base64url round-trips ids containing '#'");
  assert.equal(n.subscriberId, "s001");
  assert.equal(n.email, "r@x.example");
  assert.equal(n.bounceType, "Permanent");
  assert.equal(n.messageId, "0100abc");
});

test("a click carries the clicked link through", () => {
  const [inner] = unwrap(
    snsEvent({ eventType: "Click", mail: { tags }, click: { link: "https://a.example/x" } }),
  );
  assert.equal(normalize(inner)?.link, "https://a.example/x");
});

test("legacy notificationType and the internal shape both normalize", () => {
  assert.equal(normalize({ notificationType: "Complaint", mail: { tags } })?.eventType, "Complaint");
  const internal = { eventType: "Open" as const, orgId: "acme", campaignId: "c", subscriberId: "s" };
  assert.deepEqual(normalize(internal), internal);
});

test("an untagged or non-actionable event resolves to undefined, not a bad guess", () => {
  // Sent before tagging existed, or not one of ours.
  assert.equal(normalize({ eventType: "Bounce", mail: { tags: {} } }), undefined);
  // Types we don't act on yet must not be mistaken for actionable ones.
  assert.equal(normalize({ eventType: "Delivery", mail: { tags } }), undefined);
  assert.equal(normalize(null), undefined);
});
