/**
 * Optimistic concurrency on the compliance paths (#194).
 *
 * Every write in the adapter was last-writer-wins over a read-modify-write. On
 * most paths that is fine and intended. On four it is not, and the failures are
 * silent — the caller is told the operation succeeded:
 *
 *  - an erasure that a concurrent upsert un-does, while returning `{erased:true}`
 *  - two template saves that both write version N+1, one body lost
 *  - an out-of-order billing webhook that downgrades a paying subscriber
 *  - two signups for one address that both create a record, so an erasure can
 *    "succeed" while a complete duplicate profile survives
 *
 * These interleave the operations deliberately rather than hoping for a race.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Subscriber } from "@addressium/core";
import {
  ConcurrentModificationError,
  HmacConfirmationSigner,
  StaleEntitlementError,
  applyEntitlementSync,
  applyIdentitySync,
  eraseSubscriber,
  isNewerVersion,
  memStores,
  saveTemplate,
  signup,
  type Clock,
  type Stores,
} from "@addressium/domain";

const ORG = "summit";
const clock: Clock = { now: () => new Date("2026-07-28T12:00:00.000Z") };
const signer = new HmacConfirmationSigner("s");

const subscriber = (over: Partial<Subscriber> = {}): Subscriber => ({
  orgId: ORG,
  sub: "sub-1",
  externalId: "cognito-1",
  email: "alice@example.com",
  attributes: { first_name: "Alice" },
  status: "active",
  entitlement: "free",
  ...over,
});

async function withSubscriber(): Promise<Stores> {
  const stores = memStores();
  await stores.subscribers.put(subscriber());
  return stores;
}

test("the store owns rev — a caller cannot forge one to win a race", async () => {
  const stores = memStores();
  await stores.subscribers.put(subscriber({ rev: 999 }));
  const stored = await stores.subscribers.get(ORG, "sub-1");
  assert.equal(stored?.rev, 1000, "the store increments what it was given, it does not accept it");
});

test("a concurrent upsert cannot un-erase a subscriber", async () => {
  // THE failure this issue is named for. eraseSubscriber reads, anonymizes and
  // writes; an identity-sync upsert landing in between restores the PII, and the
  // data subject is told their data was erased.
  const stores = await withSubscriber();
  const read = (await stores.subscribers.get(ORG, "sub-1"))!;

  // The interleaving: the erase has already read, and the webhook lands.
  await applyIdentitySync(stores, clock, {
    action: "upsert",
    orgId: ORG,
    externalId: "cognito-1",
    email: "alice@example.com",
    attributes: { first_name: "Alice" },
  });

  // Now the erase tries to write what it read.
  await assert.rejects(
    () =>
      stores.subscribers.put(
        { ...read, email: `erased:${read.sub}`, attributes: {}, status: "suppressed" },
        { ifRev: read.rev },
      ),
    ConcurrentModificationError,
  );
  const after = await stores.subscribers.get(ORG, "sub-1");
  assert.equal(after?.email, "alice@example.com", "the upsert stands; the stale erase did not");
});

test("an uncontended erase still succeeds", async () => {
  // The guard must not break the normal path — an erasure that fails closed on
  // every attempt is a GDPR failure of its own.
  const stores = await withSubscriber();
  assert.equal(await eraseSubscriber(stores, clock, ORG, "alice@example.com"), true);
  const after = await stores.subscribers.get(ORG, "sub-1");
  assert.equal(after?.email, "erased:sub-1");
  assert.deepEqual(after?.attributes, {});
  assert.equal(after?.status, "suppressed");
});

test("two concurrent template saves cannot both claim version N+1", async () => {
  const stores = memStores();
  const input = {
    orgId: ORG,
    templateId: "t1",
    name: "Weekly",
    mode: "raw_html" as const,
    mergeTags: [],
    adSlots: [],
  };
  const first = await saveTemplate(stores, { ...input, source: "<p>a</p>" });
  assert.equal(first.version, 1);

  // Both writers read version 1 and compute 2. Simulated by saving twice from
  // the same observed state — the second must lose rather than silently
  // overwrite a body the archive believes it pinned separately.
  await saveTemplate(stores, { ...input, source: "<p>b</p>" });
  await assert.rejects(
    () => stores.templates.put({ ...first, version: 2, source: "<p>c</p>" }, { ifVersion: 1 }),
    ConcurrentModificationError,
  );
  const stored = await stores.templates.get(ORG, "t1");
  assert.equal(stored?.source, "<p>b</p>", "the winner's body survives intact");
  assert.equal(stored?.version, 2);
});

test("an out-of-order billing webhook cannot downgrade a paid subscriber", async () => {
  const stores = await withSubscriber();
  const sync = (entitlement: "free" | "paid", version: string) =>
    applyEntitlementSync(stores, clock, {
      orgId: ORG,
      subscriberEmail: "alice@example.com",
      entitlement,
      source: "billing",
      version,
    });

  await sync("free", "1");
  await sync("paid", "2");
  // The "free" event from before the upgrade arrives late — routine on any
  // at-least-once transport, and it used to silently strip someone's access.
  await assert.rejects(() => sync("free", "1"), StaleEntitlementError);
  assert.equal((await stores.subscribers.get(ORG, "sub-1"))?.entitlement, "paid");
});

test("a redelivery of the current version is refused, not reapplied", async () => {
  // Applying it would restamp entitlementAsof to now, making stale data look
  // fresh to every token minted afterwards.
  const stores = await withSubscriber();
  const send = () =>
    applyEntitlementSync(stores, clock, {
      orgId: ORG,
      subscriberEmail: "alice@example.com",
      entitlement: "paid",
      source: "billing",
      version: "7",
    });
  await send();
  await assert.rejects(send, StaleEntitlementError);
});

test("version ordering is numeric when it can be, lexicographic otherwise", () => {
  // `version` is an opaque string from someone else's billing system, so the
  // rule has to be stated. Purely lexicographic would reject every tenth update
  // from a counter-based feed, because "10" < "9".
  assert.equal(isNewerVersion("10", "9"), true);
  assert.equal(isNewerVersion("9", "10"), false);
  assert.equal(isNewerVersion("2026-07-28T12:00:00Z", "2026-07-28T11:00:00Z"), true);
  assert.equal(isNewerVersion("evt_b", "evt_a"), true);
  assert.equal(isNewerVersion("5", "5"), false, "equality is not newer");
});

test("two concurrent signups for one address produce ONE subscriber", async () => {
  // findByEmail reads an eventually-consistent GSI with no uniqueness
  // constraint, so both callers saw "no such subscriber". A duplicate is not
  // merely untidy: later lookups resolve non-deterministically, and an erasure
  // can report success while a full profile survives beside it.
  const stores = memStores();
  await stores.lists.put({
    orgId: ORG,
    listId: "ledger",
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "a@b.co",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "p",
  });

  const both = await Promise.all([
    signup(stores, signer, clock, { orgId: ORG, email: "new@example.com", listId: "ledger" }),
    signup(stores, signer, clock, { orgId: ORG, email: "NEW@example.com", listId: "ledger" }),
  ]);
  assert.equal(both[0].subscriber.sub, both[1].subscriber.sub, "one id, however it was cased");
  const all = await stores.subscribers.list(ORG);
  assert.equal(all.length, 1);
});

test("the reservation hands the loser the winner's id", async () => {
  const stores = memStores();
  const a = await stores.subscribers.reserveEmail(ORG, "x@example.com", "sub-a");
  const b = await stores.subscribers.reserveEmail(ORG, "x@example.com", "sub-b");
  assert.equal(a.sub, "sub-a");
  assert.equal(b.sub, "sub-a", "the loser must use the winner's id, not its own");
  // Different addresses do not contend, and neither do different orgs.
  assert.equal((await stores.subscribers.reserveEmail(ORG, "y@example.com", "sub-c")).sub, "sub-c");
  assert.equal((await stores.subscribers.reserveEmail("other", "x@example.com", "sub-d")).sub, "sub-d");
});
