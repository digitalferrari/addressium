/**
 * Drip automations: per-step choice (send / skip / exit), step advancement,
 * signup enrollment matching, and the single-recipient send path (suppression
 * gate + per-recipient idempotency).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { DripSequence, DripStep, List, Subscriber, Subscription } from "@addressium/core";
import {
  evaluateDripStep,
  nextStepIndex,
  isEnrolledBySignup,
  sendToSubscriber,
  memStores,
  CaptureSender,
  SystemClock,
  JoseMagicLinkSigner,
  type EmailTemplate,
} from "@addressium/domain";
import { generateKeyPair } from "jose";

const step: DripStep = { stepId: "welcome", waitSeconds: 0, listId: "ledger", templateId: "t", subject: "Welcome" };
const paidStep: DripStep = { ...step, stepId: "upsell", requireEntitlement: "paid" };

const sub = (over: Partial<Subscriber> = {}): Subscriber => ({
  orgId: "summit",
  sub: "s1",
  email: "a@x.com",
  attributes: {},
  status: "active",
  entitlement: "free",
  ...over,
});
const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  orgId: "summit",
  subscriberId: "s1",
  listId: "ledger",
  status: "confirmed",
  updatedAt: "t",
  ...over,
});

test("evaluateDripStep sends for an active confirmed subscriber", () => {
  assert.equal(evaluateDripStep(step, sub(), subscription()).type, "send");
});

test("evaluateDripStep exits on suppressed / unsubscribed / bounced", () => {
  assert.equal(evaluateDripStep(step, sub({ status: "suppressed" }), subscription()).type, "exit");
  assert.equal(evaluateDripStep(step, sub(), subscription({ status: "unsubscribed" })).type, "exit");
  assert.equal(evaluateDripStep(step, sub(), subscription({ status: "bounced" })).type, "exit");
  assert.equal(evaluateDripStep(step, undefined, undefined).type, "exit");
});

test("evaluateDripStep sends ONLY to a confirmed subscription of the step's list (#245)", () => {
  // Nothing downstream re-checks this. `sendToSubscriber` → `mayMail` looks at the
  // subscriber's org status and the suppression list and never at the list
  // subscription, because a broadcast derives its recipients FROM the list — it
  // fans out over the sparse confirmed index, so consent is implicit in the
  // audience. A drip step is handed a bare subscriberId by the state machine
  // instead, so it is the one place that has to ask — and it used to exit only on
  // unsubscribed/bounced/complained, which let both of these send marketing mail
  // on a list the subscriber never confirmed. Unreachable until enrollment
  // existed; live the moment it did.
  const missing = evaluateDripStep(step, sub(), undefined);
  assert.equal(missing.type, "exit");
  assert.match((missing as { reason: string }).reason, /no subscription to ledger/);

  // Signed up, never clicked. Sending here would pre-empt double opt-in.
  const pending = evaluateDripStep(step, sub(), subscription({ status: "pending" }));
  assert.equal(pending.type, "exit");
  assert.match((pending as { reason: string }).reason, /subscription pending/);

  assert.equal(evaluateDripStep(step, sub(), subscription({ status: "complained" })).type, "exit");
  assert.equal(evaluateDripStep(step, sub(), subscription({ status: "confirmed" })).type, "send");
});

test("evaluateDripStep skips when an entitlement gate is not met", () => {
  assert.equal(evaluateDripStep(paidStep, sub({ entitlement: "free" }), subscription()).type, "skip");
  assert.equal(evaluateDripStep(paidStep, sub({ entitlement: "paid" }), subscription()).type, "send");
});

test("nextStepIndex advances then completes; signup enrollment matches the list", () => {
  const seq: DripSequence = {
    orgId: "summit",
    sequenceId: "welcome",
    name: "Welcome",
    trigger: { kind: "signup", listId: "ledger" },
    steps: [step, paidStep],
  };
  assert.equal(nextStepIndex(seq, 0), 1);
  assert.equal(nextStepIndex(seq, 1), undefined);
  assert.equal(isEnrolledBySignup(seq, "ledger"), true);
  assert.equal(isEnrolledBySignup(seq, "other"), false);
});

test("sendToSubscriber sends once, gates suppression, and is idempotent", async () => {
  const stores = memStores();
  const sender = new CaptureSender();
  const clock = new SystemClock();
  const { privateKey } = await generateKeyPair("ES256");
  const magic = new JoseMagicLinkSigner(
    { privateKey, kid: "k", issuer: "i", audience: "a", ttlSeconds: 60 },
    clock,
  );
  const list: List = {
    orgId: "summit",
    listId: "ledger",
    name: "Ledger",
    optInPolicy: "single",
    fromAddress: "l@northwindtimes.example",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "a",
  };
  await stores.lists.put(list);
  await stores.subscribers.put(sub());
  const template: EmailTemplate = { blocks: [{ kind: "text", html: "hi" }] };
  const input = { orgId: "summit", campaignId: "drip-1", subscriberId: "s1", listId: "ledger", subject: "Hi", template };

  const first = await sendToSubscriber(stores, sender, magic, clock, input);
  assert.equal(first.sent, true);
  assert.equal(sender.sent.length, 1);

  const second = await sendToSubscriber(stores, sender, magic, clock, input);
  assert.equal(second.sent, false);
  assert.equal(second.reason, "already-sent");

  // suppressed subscriber (different id/email) does not receive
  await stores.subscribers.put(sub({ sub: "s2", email: "b@x.com" }));
  await stores.suppression.add({ orgId: "summit", email: "b@x.com", source: "manual", scope: "org", addedAt: "t" });
  const blocked = await sendToSubscriber(stores, sender, magic, clock, { ...input, campaignId: "drip-2", subscriberId: "s2" });
  assert.equal(blocked.sent, false);
  assert.equal(blocked.reason, "suppressed");
});
