/**
 * Proof of consent (#220, GDPR Art. 7(1) — "the controller shall be able to
 * demonstrate").
 *
 * Three defects, all in a compendium row marked **Built**:
 *   1. the IP was the hardcoded string "0.0.0.0" — a false assertion,
 *   2. no consent record at all when `sourceUrl` was absent,
 *   3. no per-subscription confirmation evidence, and `updatedAt` — the only
 *      trace of when confirmation happened — is rewritten by the next status
 *      change.
 *
 * The question these have to answer is: given (org, subscriber, list), what
 * proves that person asked for THAT newsletter?
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { List } from "@addressium/core";
import {
  HmacConfirmationSigner,
  confirmOptIn,
  confirmOptInAny,
  eraseSubscriber,
  memStores,
  signup,
  signupMany,
  unsubscribeFromList,
  type Clock,
  type Stores,
} from "@addressium/domain";

const ORG = "summit";
/**
 * Anchored to real `now`, not a literal: HmacConfirmationSigner.verify checks
 * `exp` against `Date.now()` rather than the injected clock, so a past-dated
 * fixture would always read as an expired token. Fixed for the run, so
 * timestamp assertions stay deterministic.
 */
const NOW = new Date();
const AT = NOW.toISOString();
const clock: Clock = { now: () => NOW };
const signer = new HmacConfirmationSigner("test-secret");

const CTX = { sourceIp: "203.0.113.7", userAgent: "Mozilla/5.0", sourceUrl: "https://x.example/signup" };

const list = (listId: string): List => ({
  orgId: ORG,
  listId,
  name: listId,
  optInPolicy: "double",
  fromAddress: "a@b.co",
  access: "free",
  visibility: "open",
  complianceFooter: "f",
  physicalAddress: "p",
});

async function seeded(...listIds: string[]): Promise<Stores> {
  const stores = memStores();
  for (const id of listIds) await stores.lists.put(list(id));
  return stores;
}

test('no consent record ever contains the fabricated "0.0.0.0"', async () => {
  const stores = await seeded("ledger");
  const res = await signup(stores, signer, clock, { orgId: ORG, email: "a@x.com", listId: "ledger" }, CTX);

  assert.equal(res.subscriber.consent?.ip, "203.0.113.7");
  assert.notEqual(res.subscriber.consent?.ip, "0.0.0.0");
});

test("an unknown IP omits the field rather than inventing one", async () => {
  const stores = await seeded("ledger");
  // A server-side signup with no request context — the field is simply absent.
  const res = await signup(stores, signer, clock, { orgId: ORG, email: "a@x.com", listId: "ledger" });

  assert.ok(res.subscriber.consent, "a record still exists");
  assert.equal(res.subscriber.consent?.ip, undefined, "absent is honest; 0.0.0.0 was not");
  assert.ok(res.subscriber.consent?.timestamp, "and a timestamp is still evidence");
});

test("a signup with no sourceUrl still records consent", async () => {
  const stores = await seeded("ledger");
  const res = await signup(stores, signer, clock, { orgId: ORG, email: "a@x.com", listId: "ledger" }, {
    sourceIp: "203.0.113.7",
  });

  // This used to yield `consent: undefined` — a fully mailable subscriber with
  // no provenance whatsoever.
  assert.ok(res.subscriber.consent);
  assert.equal(res.subscriber.consent?.sourceUrl, undefined);
});

test("confirmation writes per-subscription evidence", async () => {
  const stores = await seeded("ledger");
  const res = await signup(stores, signer, clock, { orgId: ORG, email: "a@x.com", listId: "ledger" }, CTX);
  assert.equal(res.subscription.consent?.confirmedAt, undefined, "not confirmed yet");

  const confirmed = await confirmOptIn(stores, signer, clock, res.confirmationToken, { sourceIp: "198.51.100.9" });

  assert.equal(confirmed.consent?.requestedAt, AT);
  assert.equal(confirmed.consent?.confirmedAt, AT);
  assert.equal(confirmed.consent?.requestIp, "203.0.113.7");
  assert.equal(confirmed.consent?.confirmIp, "198.51.100.9", "confirming from a different address is recorded");
  assert.equal(confirmed.consent?.basis, "explicit");
});

test("a later status change cannot destroy the confirmation evidence", async () => {
  const stores = await seeded("ledger");
  const res = await signup(stores, signer, clock, { orgId: ORG, email: "a@x.com", listId: "ledger" }, CTX);
  await confirmOptIn(stores, signer, clock, res.confirmationToken, CTX);

  await unsubscribeFromList(stores, clock, { orgId: ORG, subscriberId: res.subscriber.sub, listId: "ledger" });

  // `updatedAt` now points at the unsubscribe, which is exactly why it could
  // never serve as proof of when confirmation happened.
  const after = await stores.subscriptions.get(ORG, res.subscriber.sub, "ledger");
  assert.equal(after?.status, "unsubscribed");
  assert.equal(after?.consent?.confirmedAt, AT, "the evidence survives");
});

test("opting into a SECOND list records fresh provenance for that list", async () => {
  const stores = await seeded("ledger", "weekly");
  const first = await signup(stores, signer, clock, { orgId: ORG, email: "a@x.com", listId: "ledger" }, CTX);
  await confirmOptIn(stores, signer, clock, first.confirmationToken, CTX);

  const second = await signup(stores, signer, clock, { orgId: ORG, email: "a@x.com", listId: "weekly" }, {
    sourceIp: "198.51.100.1",
    sourceUrl: "https://x.example/weekly",
  });

  // The returning subscriber keeps their original subscriber-level consent, but
  // the new list gets its own record — a dispute about `weekly` cannot be
  // answered with evidence gathered for `ledger`.
  assert.equal(second.subscription.consent?.requestIp, "198.51.100.1");
  assert.equal(second.subscription.consent?.sourceUrl, "https://x.example/weekly");
  assert.equal(second.subscription.consent?.confirmedAt, undefined, "not confirmed by the first list's opt-in");
});

test("given (org, subscriber, list) the evidence is retrievable after unsubscribe and re-subscribe", async () => {
  const stores = await seeded("ledger");
  const first = await signup(stores, signer, clock, { orgId: ORG, email: "a@x.com", listId: "ledger" }, CTX);
  await confirmOptIn(stores, signer, clock, first.confirmationToken, CTX);
  await unsubscribeFromList(stores, clock, { orgId: ORG, subscriberId: first.subscriber.sub, listId: "ledger" });

  const again = await signup(stores, signer, clock, { orgId: ORG, email: "a@x.com", listId: "ledger" }, {
    sourceIp: "192.0.2.5",
  });

  const record = await stores.subscriptions.get(ORG, again.subscriber.sub, "ledger");
  assert.equal(record?.status, "pending", "a re-signup is pending again");
  assert.equal(record?.consent?.requestIp, "192.0.2.5", "the new request is recorded");
  assert.equal(
    record?.consent?.confirmedAt,
    AT,
    "and the earlier confirmation is not erased by re-requesting",
  );
});

test("batch signup records provenance on every list", async () => {
  const stores = await seeded("a", "b", "c");
  const res = await signupMany(stores, signer, clock, { orgId: ORG, email: "a@x.com", listIds: ["a", "b", "c"] }, CTX);

  assert.equal(res.subscriptions.length, 3);
  for (const s of res.subscriptions) {
    assert.equal(s.consent?.requestIp, "203.0.113.7");
    assert.equal(s.consent?.basis, "explicit");
  }

  const confirmed = await confirmOptInAny(stores, signer, clock, res.confirmationToken, CTX);
  assert.equal(confirmed.length, 3);
  for (const s of confirmed) assert.ok(s.consent?.confirmedAt);
});

test("erasure strips the identifying half of the evidence but keeps the timestamps", async () => {
  const stores = await seeded("ledger");
  const res = await signup(stores, signer, clock, { orgId: ORG, email: "a@x.com", listId: "ledger" }, CTX);
  await confirmOptIn(stores, signer, clock, res.confirmationToken, CTX);

  await eraseSubscriber(stores, clock, ORG, "a@x.com");

  const after = await stores.subscriptions.get(ORG, res.subscriber.sub, "ledger");
  // IP, user agent and source URL are personal data and must go...
  assert.equal(after?.consent?.requestIp, undefined);
  assert.equal(after?.consent?.confirmIp, undefined);
  assert.equal(after?.consent?.userAgent, undefined);
  assert.equal(after?.consent?.sourceUrl, undefined);
  // ...but an erasure request does not retroactively undo the fact that the org
  // was once entitled to mail this address.
  assert.equal(after?.consent?.confirmedAt, AT);
  assert.equal(after?.consent?.basis, "explicit");
});
