/**
 * The subscriber preference centre (#74).
 *
 * The hard part was never the UI. It is that **anyone can type any email address
 * into a form**, so a management surface that trusts a submitted address is a
 * mass-unsubscribe tool. These tests are mostly about that: who can reach whose
 * subscriptions, and what a token is allowed to do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  HmacConfirmationSigner,
  SystemClock,
  applyPreferences,
  memStores,
  preferenceCentre,
  requestPreferenceLink,
  PREFERENCE_TOKEN_TTL_SECONDS,
} from "@addressium/domain";

const ORG = "summit";
const clock = new SystemClock();

async function fixture() {
  const stores = memStores();
  const now = "2026-01-01T00:00:00.000Z";
  for (const [listId, name, visibility] of [
    ["ledger", "Ledger", "open"],
    ["weekly", "Weekly", "open"],
    ["retired", "Retired", "closed"],
  ] as const) {
    await stores.lists.put({
      orgId: ORG,
      listId,
      name,
      optInPolicy: "double",
      fromAddress: "l@x.example",
      access: "free",
      visibility,
      complianceFooter: "f",
      physicalAddress: "1 Main",
    });
  }
  await stores.subscribers.put({
    orgId: ORG,
    sub: "s-1",
    email: "reader@x.example",
    status: "active",
    entitlement: "free",
    attributes: {},
  });
  await stores.subscriptions.put({
    orgId: ORG,
    subscriberId: "s-1",
    listId: "ledger",
    status: "confirmed",
    updatedAt: now,
  });
  return stores;
}

// ---- proof of ownership ----

test("a management link is only ever minted for an address on file", async () => {
  const stores = await fixture();
  const signer = new HmacConfirmationSigner("k");
  assert.ok(await requestPreferenceLink(stores, signer, clock, { orgId: ORG, email: "reader@x.example" }));
  assert.equal(
    await requestPreferenceLink(stores, signer, clock, { orgId: ORG, email: "stranger@x.example" }),
    undefined,
  );
});

test("the address is normalised before lookup", async () => {
  // Otherwise "Reader@X.example " is a stranger, and the person who typed it
  // silently never receives the link they asked for.
  const stores = await fixture();
  const signer = new HmacConfirmationSigner("k");
  assert.ok(await requestPreferenceLink(stores, signer, clock, { orgId: ORG, email: "  Reader@X.example " }));
});

test("a management token cannot be used where a CONFIRM token is expected", async () => {
  // The guard the whole design rests on. Without it, the RFC 8058 unsubscribe
  // token — in every message ever sent, five-year TTL — would open a management
  // session over every list its holder is on.
  const stores = await fixture();
  const signer = new HmacConfirmationSigner("k");
  const { token } = (await requestPreferenceLink(stores, signer, clock, { orgId: ORG, email: "reader@x.example" }))!;
  assert.equal(signer.verifyScoped(token, "manage").sub, "s-1");
  assert.throws(() => signer.verifyScoped(token, "confirm"), /scope mismatch/);
});

test("a CONFIRM token cannot open a management session", async () => {
  const signer = new HmacConfirmationSigner("k");
  const confirmToken = signer.sign({
    orgId: ORG,
    sub: "s-1",
    listId: "ledger",
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  // No scope claim at all — every token minted before the preference centre.
  assert.equal(signer.verifyScoped(confirmToken, "confirm").sub, "s-1", "old links must keep working");
  assert.throws(() => signer.verifyScoped(confirmToken, "manage"), /scope mismatch/);
});

test("a management link is short-lived, unlike an unsubscribe link", async () => {
  // It can RE-subscribe, so a leaked one puts mail back into an inbox. An
  // unsubscribe token lives five years because a dead unsubscribe link is a
  // compliance failure; this one has no such requirement.
  assert.equal(PREFERENCE_TOKEN_TTL_SECONDS, 3600);
});

// ---- what the centre shows ----

test("the centre lists every open list, marking the ones they are on", async () => {
  const stores = await fixture();
  const view = await preferenceCentre(stores, ORG, "s-1");
  assert.equal(view.email, "reader@x.example");
  assert.deepEqual(
    view.rows.map((r) => [r.listId, r.subscribed]),
    [["ledger", true], ["weekly", false]],
  );
});

test("a CLOSED list shows only if they are on it", async () => {
  // Offering a closed list is inviting someone to subscribe to something that
  // will never send. Hiding one they are ON would trap them in it.
  const stores = await fixture();
  await stores.subscriptions.put({
    orgId: ORG,
    subscriberId: "s-1",
    listId: "retired",
    status: "confirmed",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const view = await preferenceCentre(stores, ORG, "s-1");
  assert.ok(view.rows.some((r) => r.listId === "retired"), "cannot leave a closed list");
});

// ---- what it lets them change ----

test("unsubscribing works from any list, including a closed one", async () => {
  const stores = await fixture();
  await stores.subscriptions.put({
    orgId: ORG,
    subscriberId: "s-1",
    listId: "retired",
    status: "confirmed",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const r = await applyPreferences(stores, clock, ORG, "s-1", [
    { listId: "ledger", subscribed: false },
    { listId: "retired", subscribed: false },
  ]);
  assert.deepEqual(r.unsubscribed.sort(), ["ledger", "retired"]);
  assert.deepEqual(r.rejected, [], "nothing may stand between a person and leaving");
});

test("re-subscribing goes straight to confirmed, with explicit consent recorded", async () => {
  // They are holding a token we mailed to that address — the same proof double
  // opt-in exists to collect — so a second round trip adds nothing.
  const stores = await fixture();
  await applyPreferences(stores, clock, ORG, "s-1", [{ listId: "ledger", subscribed: false }]);
  const r = await applyPreferences(stores, clock, ORG, "s-1", [{ listId: "ledger", subscribed: true }]);
  assert.deepEqual(r.resubscribed, ["ledger"]);
  const sub = await stores.subscriptions.get(ORG, "s-1", "ledger");
  assert.equal(sub?.status, "confirmed");
  assert.equal(sub?.consent?.basis, "explicit");
  assert.ok(sub?.consent?.confirmedAt);
});

test("re-subscribing does NOT resurrect a bounced or complained subscription", async () => {
  // Those are statements about the address, not preferences. Clearing them
  // through a form would undo suppression through the front door.
  for (const status of ["bounced", "complained"] as const) {
    const stores = await fixture();
    await stores.subscriptions.put({
      orgId: ORG,
      subscriberId: "s-1",
      listId: "weekly",
      status,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const r = await applyPreferences(stores, clock, ORG, "s-1", [{ listId: "weekly", subscribed: true }]);
    assert.deepEqual(r.rejected, ["weekly"], `${status} was cleared by a form`);
    assert.equal((await stores.subscriptions.get(ORG, "s-1", "weekly"))?.status, status);
  }
});

test("re-subscribing cannot join a closed list", async () => {
  const stores = await fixture();
  const r = await applyPreferences(stores, clock, ORG, "s-1", [{ listId: "retired", subscribed: true }]);
  assert.deepEqual(r.rejected, ["retired"]);
});

test("changes name only lists, so one subscriber's token touches only their rows", async () => {
  // The subscriberId comes from the TOKEN, never from the request body — a
  // change payload has no way to name another person.
  const stores = await fixture();
  await stores.subscribers.put({
    orgId: ORG,
    sub: "s-2",
    email: "other@x.example",
    status: "active",
    entitlement: "free",
    attributes: {},
  });
  await stores.subscriptions.put({
    orgId: ORG,
    subscriberId: "s-2",
    listId: "ledger",
    status: "confirmed",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await applyPreferences(stores, clock, ORG, "s-1", [{ listId: "ledger", subscribed: false }]);
  assert.equal((await stores.subscriptions.get(ORG, "s-2", "ledger"))?.status, "confirmed");
});

test("applying the same change twice is a no-op", async () => {
  const stores = await fixture();
  await applyPreferences(stores, clock, ORG, "s-1", [{ listId: "ledger", subscribed: false }]);
  const again = await applyPreferences(stores, clock, ORG, "s-1", [{ listId: "ledger", subscribed: false }]);
  assert.deepEqual(again.unsubscribed, []);
});
