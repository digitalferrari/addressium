/**
 * Signup bot mitigation (#62): honeypot detection, and opt-in post-verify
 * account provisioning that stamps the Cognito sub as the subscriber's externalId.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Subscriber } from "@addressium/core";
import {
  isHoneypotTripped,
  provisionSubscriberAccount,
  memStores,
  type SubscriberAccountProvisioner,
} from "@addressium/domain";

test("isHoneypotTripped: empty/missing/whitespace = human, filled = bot", () => {
  assert.equal(isHoneypotTripped({}), false);
  assert.equal(isHoneypotTripped({ website: "" }), false);
  assert.equal(isHoneypotTripped({ website: "   " }), false);
  assert.equal(isHoneypotTripped({ website: "http://spam" }), true);
  assert.equal(isHoneypotTripped({ trap: "x" }, "trap"), true);
});

const ORG = "summit";
const sub = (over: Partial<Subscriber> = {}): Subscriber => ({
  orgId: ORG, sub: "s1", email: "a@x.com", attributes: {}, status: "active", entitlement: "free", ...over,
});

function fakeProvisioner() {
  const calls: Array<{ poolId: string; email: string }> = [];
  const p: SubscriberAccountProvisioner = {
    async ensureAccount(poolId, email) { calls.push({ poolId, email }); return { externalId: "cog-" + email }; },
  };
  return { p, calls };
}

test("provisionSubscriberAccount creates the account and stamps externalId", async () => {
  const stores = memStores();
  await stores.subscribers.put(sub());
  const { p, calls } = fakeProvisioner();

  const updated = await provisionSubscriberAccount(stores, p, ORG, "pool-1", "s1");
  assert.equal(updated?.externalId, "cog-a@x.com");
  assert.deepEqual(calls, [{ poolId: "pool-1", email: "a@x.com" }]);
  // Now resolvable by external id.
  assert.equal((await stores.subscribers.findByExternalId(ORG, "cog-a@x.com"))?.sub, "s1");
});

test("provisionSubscriberAccount is a no-op when already linked", async () => {
  const stores = memStores();
  await stores.subscribers.put(sub({ externalId: "existing" }));
  const { p, calls } = fakeProvisioner();

  const updated = await provisionSubscriberAccount(stores, p, ORG, "pool-1", "s1");
  assert.equal(updated?.externalId, "existing");
  assert.equal(calls.length, 0); // provider never called
});

test("provisionSubscriberAccount returns undefined for an unknown subscriber", async () => {
  const stores = memStores();
  const { p } = fakeProvisioner();
  assert.equal(await provisionSubscriberAccount(stores, p, ORG, "pool-1", "nope"), undefined);
});
