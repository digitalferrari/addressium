/**
 * Re-opt-in while suppressed (#58): a prior *user unsubscribe* (org scope) is
 * self-clearable on a fresh signup — we drop it and let the double opt-in send.
 * Bounce / complaint / manual (erasure) suppression stays blocked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { List, SuppressionEntry } from "@addressium/core";
import { signup, memStores, SystemClock, HmacConfirmationSigner } from "@addressium/domain";

const ORG = "summit";
const EMAIL = "returning@x.com";

async function seed() {
  const stores = memStores();
  const clock = new SystemClock();
  const signer = new HmacConfirmationSigner("secret");
  const list: List = {
    orgId: ORG, listId: "ledger", name: "Ledger", optInPolicy: "double",
    fromAddress: "l@northwindtimes.example", access: "free", visibility: "open",
    complianceFooter: "f", physicalAddress: "a",
  };
  await stores.lists.put(list);
  return { stores, clock, signer };
}

const suppress = (over: Partial<SuppressionEntry>): SuppressionEntry => ({
  orgId: ORG, email: EMAIL, source: "unsubscribe", scope: "org", addedAt: "t", ...over,
});

const doSignup = (h: Awaited<ReturnType<typeof seed>>) =>
  signup(h.stores, h.signer, h.clock, { orgId: ORG, email: EMAIL, listId: "ledger" });

test("prior unsubscribe (org) is cleared on re-opt-in and the double opt-in proceeds", async () => {
  const h = await seed();
  await h.stores.suppression.add(suppress({ source: "unsubscribe", scope: "org" }));

  const res = await doSignup(h);
  assert.equal(res.subscription.status, "pending"); // confirmation flow started
  assert.ok(res.confirmationToken);
  // Suppression was self-cleared.
  assert.equal(await h.stores.suppression.isSuppressed(ORG, EMAIL), false);
});

test("hard bounce (global) is NOT cleared — signup is rejected", async () => {
  const h = await seed();
  await h.stores.suppression.add(suppress({ source: "bounce", scope: "global" }));
  await assert.rejects(() => doSignup(h), /suppressed/);
  assert.equal(await h.stores.suppression.isSuppressed(ORG, EMAIL), true); // still blocked
});

test("complaint and manual/erasure suppression stay blocked", async () => {
  for (const s of [suppress({ source: "complaint", scope: "global" }), suppress({ source: "manual", scope: "org" })]) {
    const h = await seed();
    await h.stores.suppression.add(s);
    await assert.rejects(() => doSignup(h), /suppressed/);
  }
});

test("unsubscribe + a bounce together stays blocked (not the only entry)", async () => {
  const h = await seed();
  await h.stores.suppression.add(suppress({ source: "unsubscribe", scope: "org" }));
  await h.stores.suppression.add(suppress({ source: "bounce", scope: "global" }));
  await assert.rejects(() => doSignup(h), /suppressed/);
});
