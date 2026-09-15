import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOMER_SYNC_ROTATION_GRACE_MS,
  customerSyncSigningInput,
  customerSyncWebhookHeaders,
  parseCustomerSyncSigningSecret,
  rotateCustomerSyncSigningSecret,
  serializeCustomerSyncSigningSecret,
  verifyCustomerSyncWebhook,
} from "@addressium/domain";

const EVENT = "summit/sub-1/ledger/2026-09-15T10:00:00.000Z/subscribed";
const BODY = '{"type":"subscribed","subscriberId":"sub-1"}';
const NOW = new Date("2026-09-15T10:00:00.000Z");

test("a legacy customer-sync secret becomes an HMAC current key without an outage", () => {
  assert.deepEqual(parseCustomerSyncSigningSecret("legacy-secret"), {
    version: 1,
    current: "legacy-secret",
  });
});

test("the HMAC covers the timestamp, event id, and exact posted bytes", () => {
  const headers = customerSyncWebhookHeaders("secret", EVENT, BODY, NOW);
  assert.equal(headers["x-addressium-timestamp"], NOW.toISOString());
  assert.ok(headers["x-addressium-signature"]?.startsWith("v1="));
  assert.equal(
    verifyCustomerSyncWebhook(
      headers["x-addressium-signature"]!,
      "secret",
      NOW.toISOString(),
      EVENT,
      BODY,
    ),
    true,
  );
  assert.equal(
    verifyCustomerSyncWebhook(
      headers["x-addressium-signature"]!,
      "secret",
      NOW.toISOString(),
      EVENT,
      BODY + " ",
    ),
    false,
  );
  assert.match(customerSyncSigningInput(NOW.toISOString(), EVENT, BODY), /^v1\./);
});

test("rotation emits both signatures only during the bounded grace window", () => {
  const rotated = rotateCustomerSyncSigningSecret("old", "new", NOW);
  assert.equal(
    Date.parse(rotated.previousExpiresAt!) - NOW.getTime(),
    CUSTOMER_SYNC_ROTATION_GRACE_MS,
  );
  const stored = serializeCustomerSyncSigningSecret(rotated);
  const during = customerSyncWebhookHeaders(stored, EVENT, BODY, NOW);
  assert.ok(during["x-addressium-previous-signature"]);
  assert.equal(
    verifyCustomerSyncWebhook(
      during["x-addressium-previous-signature"]!,
      "old",
      NOW.toISOString(),
      EVENT,
      BODY,
    ),
    true,
  );
  const after = customerSyncWebhookHeaders(
    stored,
    EVENT,
    BODY,
    new Date(NOW.getTime() + CUSTOMER_SYNC_ROTATION_GRACE_MS + 1),
  );
  assert.equal(after["x-addressium-previous-signature"], undefined);
});
