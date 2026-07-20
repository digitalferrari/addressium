/**
 * Inbound identity sync (#56/#57): add / email-change / delete keyed by the
 * immutable external id (Cognito sub). Verifies reconciliation of an email-only
 * subscriber, that an email change updates the record + email index (old email
 * stops resolving, new one resolves), and that delete tombstones the record.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Subscriber } from "@addressium/core";
import { applyIdentitySync, memStores, SystemClock } from "@addressium/domain";

const ORG = "summit";
const EXT = "cognito-sub-123";

function mk(over: Partial<Subscriber> = {}): Subscriber {
  return { orgId: ORG, sub: "local-1", email: "old@x.com", attributes: {}, status: "active", entitlement: "free", ...over };
}

test("upsert creates a new subscriber when neither externalId nor email is known", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  const res = await applyIdentitySync(stores, clock, { orgId: ORG, externalId: EXT, email: "new@x.com" });
  assert.equal(res.action, "created");
  const found = await stores.subscribers.findByExternalId(ORG, EXT);
  assert.equal(found?.email, "new@x.com");
  assert.equal(found?.externalId, EXT);
});

test("upsert links an existing email-only subscriber and stamps its externalId", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  await stores.subscribers.put(mk({ sub: "local-1", email: "person@x.com", attributes: { name: "Pat" } }));

  const res = await applyIdentitySync(stores, clock, { orgId: ORG, externalId: EXT, email: "person@x.com", attributes: { plan: "pro" } });
  assert.equal(res.action, "linked");
  assert.equal(res.subscriberId, "local-1"); // same durable id, not a new one
  const found = await stores.subscribers.findByExternalId(ORG, EXT);
  assert.equal(found?.sub, "local-1");
  assert.deepEqual(found?.attributes, { name: "Pat", plan: "pro" }); // merged
});

test("email change: update by externalId re-points the email index (old stops resolving, new resolves)", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  await stores.subscribers.put(mk({ sub: "local-1", email: "old@x.com", externalId: EXT }));

  const res = await applyIdentitySync(stores, clock, { orgId: ORG, externalId: EXT, email: "brand-new@x.com" });
  assert.equal(res.action, "updated");
  assert.equal(res.subscriberId, "local-1"); // identity unchanged
  assert.equal((await stores.subscribers.findByEmail(ORG, "old@x.com")), undefined);
  assert.equal((await stores.subscribers.findByEmail(ORG, "brand-new@x.com"))?.sub, "local-1");
});

test("delete tombstones the subscriber (anonymized, suppressed) and blocks re-add", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  await stores.subscribers.put(mk({ sub: "local-1", email: "gone@x.com", externalId: EXT }));

  const res = await applyIdentitySync(stores, clock, { orgId: ORG, externalId: EXT, action: "delete" });
  assert.equal(res.action, "deleted");
  const after = await stores.subscribers.get(ORG, "local-1");
  assert.equal(after?.status, "suppressed");
  assert.match(after?.email ?? "", /^erased:/); // PII anonymized
  assert.equal(await stores.suppression.isSuppressed(ORG, "gone@x.com"), true);
});

test("delete of an unknown externalId is a no-op", async () => {
  const stores = memStores();
  const res = await applyIdentitySync(stores, new SystemClock(), { orgId: ORG, externalId: "nope", action: "delete" });
  assert.equal(res.action, "noop");
});
