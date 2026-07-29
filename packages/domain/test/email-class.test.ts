/**
 * Class-aware send eligibility (#237).
 *
 * The platform was single-class: one `mayMail` gate, one set of rules. That is
 * a correctness problem, not a tidiness one. Someone who leaves a newsletter and
 * then triggers a password reset ten minutes later has said nothing about the
 * password reset — but a hard bounce or a spam complaint IS a statement about
 * the address, and binds everything.
 *
 * These tests pin exactly where that line falls, in both directions: too strict
 * withholds mail people need, too loose keeps mailing an address that bounced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { EmailClass, SuppressionSource } from "@addressium/core";
import { memStores, SystemClock, sendToSubscriber, type EmailTemplate, type SentMessage } from "@addressium/domain";

const ORG = "summit";
const SUB = "s-1";
const EMAIL = "reader@x.example";
const template: EmailTemplate = { blocks: [{ kind: "text", html: "<p>hi</p>" }] };

async function scenario(opts: {
  source?: SuppressionSource;
  subscriberSuppressed?: boolean;
  emailClass?: EmailClass;
}) {
  const stores = memStores();
  const sent: string[] = [];
  await stores.organizations.put({
    orgId: ORG,
    name: "Summit",
    domains: ["x.example"],
    sesConfigSet: "cs",
    ipMode: "shared",
    suppressionScope: "org",
    defaultTimezone: "UTC",
    setupComplete: true,
  });
  await stores.lists.put({
    orgId: ORG,
    listId: "ledger",
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "l@x.example",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "1 Main",
  });
  await stores.subscribers.put({
    orgId: ORG,
    sub: SUB,
    email: EMAIL,
    status: opts.subscriberSuppressed ? "suppressed" : "active",
    entitlement: "free",
    attributes: {},
  });
  if (opts.source) {
    await stores.suppression.add({
      orgId: ORG,
      email: EMAIL,
      scope: "org",
      source: opts.source,
      addedAt: "2026-01-02T00:00:00.000Z",
    });
  }
  const result = await sendToSubscriber(
    stores,
    { send: async (m: SentMessage) => void sent.push(m.to) },
    undefined,
    new SystemClock(),
    {
      orgId: ORG,
      campaignId: `c-${opts.source ?? "none"}-${opts.emailClass ?? "marketing"}`,
      subscriberId: SUB,
      listId: "ledger",
      subject: "s",
      template,
      ...(opts.emailClass ? { emailClass: opts.emailClass } : {}),
    },
  );
  return { result, sent };
}

// ---- the sources that bind BOTH classes ----

for (const source of ["bounce", "complaint"] as const) {
  test(`a ${source} blocks transactional mail too`, async () => {
    // A statement about the ADDRESS. Continuing to mail it is a direct
    // reputation cost, and for a complaint it is an explicit request to stop.
    const { result } = await scenario({ source: source as SuppressionSource, emailClass: "transactional" });
    assert.equal(result.sent, false);
    assert.equal(result.reason, "suppressed");
  });
}

test("a MANUAL suppression blocks transactional mail", async () => {
  // An admin who reaches for the suppression button means "stop mailing this
  // person". Reading that as "stop the newsletters only" silently narrows an
  // instruction whose reason we cannot see.
  const { result } = await scenario({ source: "manual", emailClass: "transactional" });
  assert.equal(result.sent, false);
});

// ---- and the ones that are about MARKETING only ----

for (const source of ["unsubscribe", "inactive"] as const) {
  test(`a ${source} suppression does NOT block transactional mail`, async () => {
    // The correctness item in #237: leaving a newsletter says nothing about the
    // receipt or the confirmation the same person triggers next.
    const { result, sent } = await scenario({ source: source as SuppressionSource, emailClass: "transactional" });
    assert.equal(result.sent, true, `blocked: ${result.reason}`);
    assert.deepEqual(sent, [EMAIL]);
  });

  test(`a ${source} suppression DOES block marketing mail`, async () => {
    const { result } = await scenario({ source: source as SuppressionSource, emailClass: "marketing" });
    assert.equal(result.sent, false);
    assert.equal(result.reason, "suppressed");
  });
}

// ---- defaults and the ambiguous case ----

test("omitting emailClass gets the STRICTER rules, not a bypass", async () => {
  // A caller that forgets to declare its class must not accidentally skip the
  // gate. Absent reads as marketing.
  const { result } = await scenario({ source: "unsubscribe" });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "suppressed");
});

test("a suppressed subscriber with NO suppression entry fails closed", async () => {
  // The subscriber-level flag carries no source, so on its own it is ambiguous.
  // With no entries to explain it, an unexplained suppression is not one to
  // reason past — even for transactional.
  const { result } = await scenario({ subscriberSuppressed: true, emailClass: "transactional" });
  assert.equal(result.sent, false);
});

test("a suppressed subscriber whose entry is an unsubscribe still gets transactional", async () => {
  // The flag and the entry describe the same event; resolving the flag against
  // the entry is what stops #193's rename fix from silently re-blocking every
  // transactional message.
  const { result } = await scenario({
    subscriberSuppressed: true,
    source: "unsubscribe",
    emailClass: "transactional",
  });
  assert.equal(result.sent, true, `blocked: ${result.reason}`);
});

test("an unsuppressed subscriber is mailable in both classes", async () => {
  for (const emailClass of ["marketing", "transactional"] as const) {
    const { result } = await scenario({ emailClass });
    assert.equal(result.sent, true, `${emailClass}: ${result.reason}`);
  }
});
