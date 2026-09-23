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
      // Verified at the instant it was SIGNED. Without this the call is
      // testing the five-minute replay window (#295) rather than the HMAC,
      // and would start failing the moment NOW drifts into the past.
      { now: NOW },
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
      { now: NOW },
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
      // Verified at the instant it was SIGNED. Without this the call is
      // testing the five-minute replay window (#295) rather than the HMAC,
      // and would start failing the moment NOW drifts into the past.
      { now: NOW },
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

/**
 * The replay window (#295).
 *
 * `docs/ARCHITECTURE.md` tells receivers to "reject timestamps outside their
 * replay window". The reference verifier did not, which taught every
 * integration author copying it to omit the same rule — and without a window a
 * captured request stays valid forever, since the signature never expires.
 */
test("a stale delivery is refused even with a valid signature", () => {
  const headers = customerSyncWebhookHeaders("secret", EVENT, BODY, NOW);
  const sixMinutesLater = new Date(NOW.getTime() + 6 * 60 * 1000);
  assert.equal(
    verifyCustomerSyncWebhook(
      headers["x-addressium-signature"]!,
      "secret",
      NOW.toISOString(),
      EVENT,
      BODY,
      { now: sixMinutesLater },
    ),
    false,
    "the signature is still valid — the timestamp is what makes it refusable",
  );
});

test("a delivery from the future is refused too", () => {
  // As suspicious as an old one, and the easier mistake to make when an
  // attacker controls neither clock: a receiver whose clock runs slow would
  // otherwise accept anything dated ahead.
  const headers = customerSyncWebhookHeaders("secret", EVENT, BODY, NOW);
  const sixMinutesEarlier = new Date(NOW.getTime() - 6 * 60 * 1000);
  assert.equal(
    verifyCustomerSyncWebhook(
      headers["x-addressium-signature"]!,
      "secret",
      NOW.toISOString(),
      EVENT,
      BODY,
      { now: sixMinutesEarlier },
    ),
    false,
  );
});

test("ordinary clock skew is tolerated", () => {
  // Two machines minutes apart is normal; refusing that would make the feature
  // an outage rather than a control.
  const headers = customerSyncWebhookHeaders("secret", EVENT, BODY, NOW);
  for (const offset of [-4 * 60 * 1000, 0, 4 * 60 * 1000]) {
    assert.equal(
      verifyCustomerSyncWebhook(
        headers["x-addressium-signature"]!,
        "secret",
        NOW.toISOString(),
        EVENT,
        BODY,
        { now: new Date(NOW.getTime() + offset) },
      ),
      true,
      `${offset / 1000}s of skew must be accepted`,
    );
  }
});

test("an unparseable timestamp is refused rather than treated as now", () => {
  // Otherwise a sender that omits or mangles the header gets a free pass.
  assert.equal(
    verifyCustomerSyncWebhook("v1=deadbeef", "secret", "not-a-date", EVENT, BODY, { now: NOW }),
    false,
  );
});

test("the window is overridable, because a receiver's tolerance is theirs to set", () => {
  const headers = customerSyncWebhookHeaders("secret", EVENT, BODY, NOW);
  assert.equal(
    verifyCustomerSyncWebhook(
      headers["x-addressium-signature"]!,
      "secret",
      NOW.toISOString(),
      EVENT,
      BODY,
      { now: new Date(NOW.getTime() + 6 * 60 * 1000), maxSkewMs: 10 * 60 * 1000 },
    ),
    true,
  );
});
