/**
 * One-time resend to non-engaged recipients (#54): the non-engaged set is
 * derived from the engagement log (received, but no open and no click), the
 * resend goes out under a `#resend` sub-campaign, suppression is honored, and a
 * second trigger is a no-op (idempotent).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { EngagementEvent, List, Subscriber } from "@addressium/core";
import {
  nonEngagedSubscribers,
  resendToNonEngaged,
  resendCampaignId,
  memStores,
  CaptureSender,
  SystemClock,
  JoseMagicLinkSigner,
  type EmailTemplate,
} from "@addressium/domain";
import { generateKeyPair } from "jose";

const ORG = "summit";
const CAMPAIGN = "ledger-jul20";

const evt = (type: EngagementEvent["type"], subscriberId: string, campaignId = CAMPAIGN): EngagementEvent => ({
  orgId: ORG,
  campaignId,
  subscriberId,
  type,
  at: "2026-07-20T00:00:00Z",
});

test("nonEngagedSubscribers = received minus (opened or clicked)", () => {
  const events = [
    evt("sent", "a"), evt("sent", "b"), evt("sent", "c"), evt("sent", "d"),
    evt("open", "a"), // a opened
    evt("click", "b"), // b clicked
    // c and d did neither
  ];
  assert.deepEqual(nonEngagedSubscribers(events), ["c", "d"]);
});

test("a subscriber who both opened and clicked is still excluded exactly once", () => {
  const events = [evt("sent", "a"), evt("open", "a"), evt("click", "a"), evt("sent", "b")];
  assert.deepEqual(nonEngagedSubscribers(events), ["b"]);
});

async function harness() {
  const stores = memStores();
  const sender = new CaptureSender();
  const clock = new SystemClock();
  const { privateKey } = await generateKeyPair("ES256");
  const magic = new JoseMagicLinkSigner({ privateKey, kid: "k", issuer: "i", audience: "a", ttlSeconds: 60 }, clock);
  const list: List = {
    orgId: ORG, listId: "ledger", name: "Ledger", optInPolicy: "single",
    fromAddress: "l@northwindtimes.example", access: "free", visibility: "open",
    complianceFooter: "f", physicalAddress: "a",
  };
  await stores.lists.put(list);
  const sub = (id: string, email: string): Subscriber => ({
    orgId: ORG, sub: id, email, attributes: {}, status: "active", entitlement: "free",
  });
  for (const [id, email] of [["a", "a@x.com"], ["b", "b@x.com"], ["c", "c@x.com"], ["d", "d@x.com"]] as const) {
    await stores.subscribers.put(sub(id, email));
  }
  // a opened, b clicked; c and d received but never engaged.
  for (const e of [evt("sent", "a"), evt("sent", "b"), evt("sent", "c"), evt("sent", "d"), evt("open", "a"), evt("click", "b")]) {
    await stores.events.append(e);
  }
  return { stores, sender, clock, magic };
}

test("resendToNonEngaged sends to non-openers, skips suppressed, and aggregates under #resend", async () => {
  const { stores, sender, clock, magic } = await harness();
  // d is suppressed → must be excluded from the resend.
  await stores.suppression.add({ orgId: ORG, email: "d@x.com", source: "bounce", scope: "org", addedAt: "t" });

  const template: EmailTemplate = { blocks: [{ kind: "text", html: "second look" }] };
  const res = await resendToNonEngaged(stores, sender, magic, clock, {
    orgId: ORG, originalCampaignId: CAMPAIGN, listId: "ledger", subject: "Did you miss this?", template,
  });

  assert.equal(res.resendCampaignId, resendCampaignId(CAMPAIGN));
  assert.equal(res.targeted, 2); // c and d
  assert.equal(res.sent, 1); // only c
  assert.equal(res.suppressed, 1); // d
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0]?.to, "c@x.com");
  assert.equal(sender.sent[0]?.subject, "Did you miss this?");

  // The resend recorded its own "sent" event under the #resend sub-campaign.
  const resendEvents = await stores.events.all(ORG, resendCampaignId(CAMPAIGN));
  assert.equal(resendEvents.filter((e) => e.type === "sent").length, 1);
});

test("a second resend trigger is a no-op (idempotent)", async () => {
  const { stores, sender, clock, magic } = await harness();
  const template: EmailTemplate = { blocks: [{ kind: "text", html: "second look" }] };
  const input = { orgId: ORG, originalCampaignId: CAMPAIGN, listId: "ledger", subject: "Again?", template };

  const first = await resendToNonEngaged(stores, sender, magic, clock, input);
  assert.equal(first.sent, 2); // c and d (none suppressed here)
  assert.equal(sender.sent.length, 2);

  const second = await resendToNonEngaged(stores, sender, magic, clock, input);
  assert.equal(second.sent, 0);
  assert.equal(second.alreadySent, 2);
  assert.equal(sender.sent.length, 2); // nothing new sent
});
