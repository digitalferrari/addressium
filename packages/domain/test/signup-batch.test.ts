/**
 * Multi-list signup for the "All newsletters" page (#61): opt into several lists
 * at once with ONE double opt-in token; confirmOptInAny confirms them all;
 * closed lists are skipped; a re-opt-in still honors the suppression policy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { List } from "@addressium/core";
import { signupMany, confirmOptInAny, memStores, SystemClock, HmacConfirmationSigner } from "@addressium/domain";

const ORG = "summit";

function list(over: Partial<List> & { listId: string }): List {
  return {
    orgId: ORG, name: over.listId, optInPolicy: "double", fromAddress: "l@northwindtimes.example",
    access: "free", visibility: "open", complianceFooter: "f", physicalAddress: "a", ...over,
  };
}

async function seed() {
  const stores = memStores();
  const clock = new SystemClock();
  const signer = new HmacConfirmationSigner("secret");
  await stores.lists.put(list({ listId: "ledger" }));
  await stores.lists.put(list({ listId: "signal" }));
  await stores.lists.put(list({ listId: "closed-one", visibility: "closed" }));
  return { stores, clock, signer };
}

test("signupMany creates one subscriber + a pending subscription per open list, one token", async () => {
  const { stores, clock, signer } = await seed();
  const res = await signupMany(stores, signer, clock, { orgId: ORG, email: "reader@x.com", listIds: ["ledger", "signal", "closed-one"] });

  assert.deepEqual(res.lists.map((l) => l.listId).sort(), ["ledger", "signal"]); // closed skipped
  assert.equal(res.subscriptions.length, 2);
  assert.ok(res.subscriptions.every((s) => s.status === "pending"));
  // A single subscriber id backs all of them.
  assert.equal(new Set(res.subscriptions.map((s) => s.subscriberId)).size, 1);
});

test("confirmOptInAny confirms every list carried by the batch token", async () => {
  const { stores, clock, signer } = await seed();
  const res = await signupMany(stores, signer, clock, { orgId: ORG, email: "reader@x.com", listIds: ["ledger", "signal"] });

  const confirmed = await confirmOptInAny(stores, signer, clock, res.confirmationToken);
  assert.equal(confirmed.length, 2);
  assert.ok(confirmed.every((s) => s.status === "confirmed"));

  // Both memberships are now confirmed in the store.
  const ledger = await stores.subscriptions.get(ORG, res.subscriber.sub, "ledger");
  const signal = await stores.subscriptions.get(ORG, res.subscriber.sub, "signal");
  assert.equal(ledger?.status, "confirmed");
  assert.equal(signal?.status, "confirmed");
});

test("signupMany with only closed/unknown lists throws", async () => {
  const { stores, clock, signer } = await seed();
  await assert.rejects(
    () => signupMany(stores, signer, clock, { orgId: ORG, email: "reader@x.com", listIds: ["closed-one", "nope"] }),
    /no open lists/,
  );
});

test("signupMany honors the suppression policy (bounce stays blocked)", async () => {
  const { stores, clock, signer } = await seed();
  await stores.suppression.add({ orgId: ORG, email: "bounced@x.com", source: "bounce", scope: "global", addedAt: "t" });
  await assert.rejects(
    () => signupMany(stores, signer, clock, { orgId: ORG, email: "bounced@x.com", listIds: ["ledger"] }),
    /suppressed/,
  );
});
