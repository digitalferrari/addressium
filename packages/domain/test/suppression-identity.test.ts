/**
 * Suppression must survive an email change (#193).
 *
 * `SuppressionEntry` is keyed by EMAIL; `Subscriber` is keyed by `sub`. The two
 * keys drift the moment someone changes their address, and the drift is silent
 * and one-directional: the person who filed the complaint becomes mailable, and
 * nothing in the system reports it. `subscriber.status` said `suppressed` the
 * whole time and no code read it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Subscriber } from "@addressium/core";
import {
  CaptureSender,
  applyIdentitySync,
  memStores,
  sendCampaign,
  type Clock,
  type EmailTemplate,
  type Stores,
} from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";
const NOW = "2026-07-28T12:00:00.000Z";
const clock: Clock = { now: () => new Date(NOW) };
const template: EmailTemplate = { html: "<p>hi</p>" };

async function seeded(): Promise<{ stores: Stores; subscriber: Subscriber }> {
  const stores = memStores();
  await stores.lists.put({
    orgId: ORG,
    listId: LIST,
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "a@b.co",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "p",
  });
  const subscriber: Subscriber = {
    orgId: ORG,
    sub: "sub-1",
    externalId: "cognito-1",
    email: "alice@old.example",
    attributes: {},
    status: "active",
    entitlement: "free",
  };
  await stores.subscribers.put(subscriber);
  await stores.subscriptions.put({
    orgId: ORG,
    subscriberId: "sub-1",
    listId: LIST,
    status: "confirmed",
    updatedAt: NOW,
  });
  return { stores, subscriber };
}

const complaintAgainst = (email: string) => ({
  orgId: ORG,
  email,
  source: "complaint" as const,
  scope: "global" as const,
  addedAt: "2026-01-15T09:00:00.000Z",
});

const rename = (stores: Stores, email: string) =>
  applyIdentitySync(stores, clock, {
    action: "upsert",
    orgId: ORG,
    externalId: "cognito-1",
    email,
  });

test("a complaint follows the address change", async () => {
  // The end-to-end failure this exists to prevent: complain from the old
  // address, change it, and the send path sees a clean record.
  const { stores } = await seeded();
  await stores.suppression.add(complaintAgainst("alice@old.example"));
  assert.equal(await stores.suppression.isSuppressed(ORG, "alice@old.example"), true);

  await rename(stores, "alice@new.example");
  assert.equal(
    await stores.suppression.isSuppressed(ORG, "alice@new.example"),
    true,
    "the new address inherits the complaint",
  );
});

test("the carried entry keeps WHEN and WHY, not the rename's date", async () => {
  // "Suppressed since the complaint" is the fact a deliverability dispute turns
  // on. Restamping it to the rename would erase the only evidence of when it
  // actually happened.
  const { stores } = await seeded();
  await stores.suppression.add(complaintAgainst("alice@old.example"));
  await rename(stores, "alice@new.example");

  const [carried] = await stores.suppression.entriesFor(ORG, "alice@new.example");
  assert.equal(carried?.source, "complaint");
  assert.equal(carried?.scope, "global", "a global complaint must not narrow to one org");
  assert.equal(carried?.addedAt, "2026-01-15T09:00:00.000Z");
});

test("the old tombstone is kept, not moved", async () => {
  // Deleting it is the obvious symmetric move and it is wrong in the direction
  // that matters: if the rename is itself the mistake — a bad identity feed, an
  // address reused by someone else — removing the tombstone makes a complainer
  // mailable again. A stale row costs one item and never sends an email.
  const { stores } = await seeded();
  await stores.suppression.add(complaintAgainst("alice@old.example"));
  await rename(stores, "alice@new.example");
  assert.equal(await stores.suppression.isSuppressed(ORG, "alice@old.example"), true);
});

test("a rename that does not change the address carries nothing", async () => {
  const { stores } = await seeded();
  await stores.suppression.add(complaintAgainst("alice@old.example"));
  await rename(stores, "ALICE@OLD.EXAMPLE"); // normalizes to the same value
  assert.equal((await stores.suppression.entriesFor(ORG, "alice@old.example")).length, 1);
});

test("a subscriber marked suppressed is never mailed, whatever their address says", async () => {
  // The second line. `isSuppressed` is keyed by email and goes blind on a
  // rename; `status` is keyed by the durable `sub` and survives one. Nothing
  // read `status` before, so a suppressed subscriber whose email changed was
  // mailable while their own record said otherwise.
  const { stores, subscriber } = await seeded();
  await stores.subscribers.put({ ...subscriber, status: "suppressed" });

  const sender = new CaptureSender();
  const out = await sendCampaign(stores, sender, undefined, clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "s",
    template,
  });
  assert.equal(out.sent, 0);
  assert.equal(out.suppressed, 1);
  assert.deepEqual(sender.sent, []);
});

test("an active subscriber with no suppression entry is still mailed", async () => {
  // The guard must not be so broad that it stops the product working.
  const { stores } = await seeded();
  const sender = new CaptureSender();
  const out = await sendCampaign(stores, sender, undefined, clock, {
    orgId: ORG,
    campaignId: "c2",
    listId: LIST,
    subject: "s",
    template,
  });
  assert.equal(out.sent, 1);
});

test("end to end: complain, rename, and the campaign still refuses", async () => {
  const { stores } = await seeded();
  await stores.suppression.add(complaintAgainst("alice@old.example"));
  await rename(stores, "alice@new.example");

  const sender = new CaptureSender();
  const out = await sendCampaign(stores, sender, undefined, clock, {
    orgId: ORG,
    campaignId: "c3",
    listId: LIST,
    subject: "s",
    template,
  });
  assert.equal(out.sent, 0, "mailed a person who filed a spam complaint");
  assert.equal(out.suppressed, 1);
});
