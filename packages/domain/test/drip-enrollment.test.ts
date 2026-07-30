/**
 * Drip enrollment: which sequences a confirmation enters, the first execution
 * input, the execution name, and the per-enrollment claim namespace (#245).
 *
 * The bug this covers was not a wrong answer — every function here was correct
 * before and after. It was that nothing CALLED them: `isEnrolledBySignup` had no
 * caller outside its own unit test, so an operator could author a welcome
 * sequence, see it in the console, and have it never send anything to anybody.
 *
 * Two of these assertions therefore pin identifiers rather than behaviour. The
 * execution NAME is the only thing standing between a triple-clicked confirmation
 * link and three enrollments, and the per-step CAMPAIGN ID is the only thing
 * standing between a re-subscribe and a sequence that emails nobody — both leak
 * into flat foreign namespaces (Step Functions execution names; the permanent
 * send-claim key) where a collision is somebody else's 400 or somebody's missing
 * mail. See packages/domain/test/id-hardening.test.ts for the same doctrine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { DripSequence, DripStep, Subscription } from "@addressium/core";
import {
  MemDripStarter,
  dripCampaignId,
  dripExecutionName,
  enrollManually,
  enrollOnConfirmation,
  enrollmentIdFor,
  enrollmentSuperseded,
  initialEnrollment,
  memStores,
} from "@addressium/domain";

const REQUESTED_AT = "2027-03-01T09:00:00.000Z";

const step = (over: Partial<DripStep> = {}): DripStep => ({
  stepId: "welcome",
  waitSeconds: 0,
  listId: "ledger",
  templateId: "t",
  subject: "Welcome",
  ...over,
});

const sequence = (over: Partial<DripSequence> = {}): DripSequence => ({
  orgId: "summit",
  sequenceId: "welcome",
  name: "Welcome",
  trigger: { kind: "signup", listId: "ledger" },
  steps: [step({ waitSeconds: 259_200 }), step({ stepId: "second", waitSeconds: 86_400 })],
  ...over,
});

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  orgId: "summit",
  subscriberId: "s1",
  listId: "ledger",
  status: "confirmed",
  updatedAt: "2027-03-02T10:00:00.000Z",
  consent: { requestedAt: REQUESTED_AT, confirmedAt: "2027-03-02T10:00:00.000Z", basis: "explicit" },
  ...over,
});

/** memStores() + a capture starter, with `seqs` already stored. */
async function fixture(...seqs: DripSequence[]) {
  const stores = memStores();
  for (const s of seqs) await stores.dripSequences.put(s);
  return { stores, starter: new MemDripStarter() };
}

test("a confirmed signup starts the matching sequence at step 0 with step 0's wait", async () => {
  // The whole of #245 in one assertion. Note nextWaitSeconds is step 0's OWN
  // wait: the machine starts at the Wait (#201), so "three days after signup"
  // must arrive three days later rather than at signup.
  const { stores, starter } = await fixture(sequence());
  const started = await enrollOnConfirmation(stores, starter, [subscription()]);

  assert.equal(started.length, 1);
  assert.deepEqual(started[0], {
    orgId: "summit",
    sequenceId: "welcome",
    subscriberId: "s1",
    nextStepIndex: 0,
    nextWaitSeconds: 259_200,
    enrollmentId: REQUESTED_AT,
  });
  assert.equal(starter.started.size, 1);
});

test("a signup on a list no sequence is triggered by starts nothing", async () => {
  const { stores, starter } = await fixture(sequence());
  const started = await enrollOnConfirmation(stores, starter, [subscription({ listId: "dispatch" })]);
  assert.deepEqual(started, []);
  assert.equal(starter.calls.length, 0);
});

test("a sequence with zero steps starts no execution", async () => {
  // The machine would wait, invoke the step handler for step 0 of an empty list,
  // get "no such step" and Succeed — an execution whose entire life is to prove
  // it had nothing to do. The API schema requires `.min(1)`, so this is only
  // reachable by writing to the store directly, which is exactly the input no
  // schema guards.
  const { stores, starter } = await fixture(sequence({ steps: [] }));
  assert.deepEqual(await enrollOnConfirmation(stores, starter, [subscription()]), []);
  assert.equal(starter.calls.length, 0);
  assert.equal(initialEnrollment(sequence({ steps: [] }), "s1", REQUESTED_AT), undefined);
});

test("a manual-trigger sequence is not started by a signup", async () => {
  // `trigger` declares how a sequence is ENTERED. A manual sequence that also
  // fired on signup would double-enroll everyone the operator hand-enrolled.
  const { stores, starter } = await fixture(sequence({ trigger: { kind: "manual" } }));
  assert.deepEqual(await enrollOnConfirmation(stores, starter, [subscription()]), []);
  assert.equal(starter.calls.length, 0);
});

test("a batch confirmation enrolls for EVERY list it confirmed, not just the first", async () => {
  // One token carries every listId, so one click confirms several lists. Reading
  // `subs[0]` — which is what the neighbouring provisioning side effect does —
  // would enroll for whichever list happened to be first and drop the rest.
  const { stores, starter } = await fixture(
    sequence(),
    sequence({
      sequenceId: "dispatch-welcome",
      trigger: { kind: "signup", listId: "dispatch" },
      steps: [step({ listId: "dispatch", waitSeconds: 60 })],
    }),
  );
  const started = await enrollOnConfirmation(stores, starter, [
    subscription(),
    subscription({ listId: "dispatch" }),
  ]);
  assert.deepEqual(started.map((e) => e.sequenceId).sort(), ["dispatch-welcome", "welcome"]);
});

test("confirming three times enrolls once", async () => {
  // The subscriber double-clicks, or their mail client prefetches the link. Every
  // call returns the same confirmed subscription with the same `requestedAt`, so
  // every call computes the same execution name — and the name is the dedupe.
  const { stores, starter } = await fixture(sequence());
  for (let i = 0; i < 3; i++) await enrollOnConfirmation(stores, starter, [subscription()]);
  assert.equal(starter.calls.length, 3, "the domain does not pretend to remember");
  assert.equal(starter.started.size, 1, "but only one execution exists");
});

test("enrollment identity comes from requestedAt, not from the fields that move", async () => {
  // `confirmedAt` and `updatedAt` are re-stamped with `now` on EVERY confirmation
  // call, and both sit on the object handed to `enrollmentIdFor` — tempting and
  // wrong. Keying off either would enroll a triple-clicker three times.
  const clickOne = subscription({ updatedAt: "2027-03-02T10:00:00.000Z" });
  const clickThree = subscription({
    updatedAt: "2027-03-02T10:00:09.000Z",
    consent: { requestedAt: REQUESTED_AT, confirmedAt: "2027-03-02T10:00:09.000Z", basis: "explicit" },
  });
  assert.equal(enrollmentIdFor(clickOne), enrollmentIdFor(clickThree));
  assert.notEqual(clickOne.updatedAt, clickThree.updatedAt, "the volatile fields really do move");
  assert.notEqual(clickOne.consent?.confirmedAt, clickThree.consent?.confirmedAt);

  // A pre-#220 record has no consent at all. One sentinel, so it enrolls once —
  // rather than falling back to a field that changes on every click.
  assert.equal(enrollmentIdFor(subscription({ consent: undefined })), "legacy");
});

test("a re-subscribe is a NEW enrollment, with its own execution and its own claims", async () => {
  // unsubscribe → re-signup → confirm. `pendingSubscription` overwrites
  // `requestedAt` with `now`, so this is a genuinely different enrollment and the
  // subscriber gets the welcome sequence again.
  const { stores, starter } = await fixture(sequence());
  await enrollOnConfirmation(stores, starter, [subscription()]);
  const again = subscription({
    consent: { requestedAt: "2028-01-05T08:00:00.000Z", confirmedAt: "2028-01-05T08:05:00.000Z", basis: "explicit" },
  });
  await enrollOnConfirmation(stores, starter, [again]);
  assert.equal(starter.started.size, 2, "the second signup must run the sequence again");

  // ...and the claim namespaces must differ too, or the second execution runs to
  // completion sending nothing: the claim is a permanent Put with no TTL, so the
  // first run's keys are burned forever. This is #207, one automation over.
  assert.notEqual(
    dripCampaignId("welcome", "welcome", REQUESTED_AT),
    dripCampaignId("welcome", "welcome", "2028-01-05T08:00:00.000Z"),
  );
  // Within one enrollment it is stable, so a retried step still dedupes.
  assert.equal(dripCampaignId("welcome", "welcome", REQUESTED_AT), `drip:welcome#${REQUESTED_AT}#welcome`);
  // No enrollment id — an execution started before the field existed — keeps the
  // original key rather than silently restarting mid-sequence.
  assert.equal(dripCampaignId("welcome", "welcome"), "drip-welcome-welcome");
});

test("manual enrollment starts a manual sequence and refuses a signup one", async () => {
  const manual = sequence({ sequenceId: "onboarding", trigger: { kind: "manual" }, steps: [step({ waitSeconds: 30 })] });
  const { stores, starter } = await fixture(manual, sequence());
  // The subscriber must already have confirmed the list step 0 mails — see the
  // consent test below for what happens when they have not.
  await stores.subscriptions.put(subscription());

  const enrollment = await enrollManually(stores, starter, {
    orgId: "summit",
    sequenceId: "onboarding",
    subscriberId: "s1",
    enrollmentId: "manual.2027-03-04T00:00:00.000Z",
  });
  assert.deepEqual(enrollment, {
    orgId: "summit",
    sequenceId: "onboarding",
    subscriberId: "s1",
    nextStepIndex: 0,
    nextWaitSeconds: 30,
    enrollmentId: "manual.2027-03-04T00:00:00.000Z",
  });

  // Hand-starting a signup sequence would put the same person in it twice, under
  // two claim namespaces, so they receive every step twice.
  await assert.rejects(
    enrollManually(stores, starter, { orgId: "summit", sequenceId: "welcome", subscriberId: "s1", enrollmentId: "x" }),
    /signup-triggered, not manual/,
  );
  await assert.rejects(
    enrollManually(stores, starter, { orgId: "summit", sequenceId: "nope", subscriberId: "s1", enrollmentId: "x" }),
    /unknown drip sequence/,
  );
});

test("hand enrollment refuses a subscriber who has not confirmed the list it mails", async () => {
  // The route takes a bare subscriberId, so this is the only consent check in
  // front of it. Without it an operator could aim a sequence at anyone in the org
  // and the sequence would mail them a list they never joined — or, once
  // `evaluateDripStep` exits instead, start an execution that dies at step 0 while
  // the operator is told 200 and no mail ever arrives. Both are silences; this is
  // an answer.
  const manual = sequence({ sequenceId: "onboarding", trigger: { kind: "manual" }, steps: [step({ waitSeconds: 30 })] });
  const { stores, starter } = await fixture(manual);
  const enroll = () =>
    enrollManually(stores, starter, {
      orgId: "summit",
      sequenceId: "onboarding",
      subscriberId: "s1",
      enrollmentId: "manual.1",
    });

  await assert.rejects(enroll(), /no confirmed subscription to ledger/);
  assert.equal(starter.calls.length, 0, "nothing may be started");

  // Signed up and never clicked is not consent either, and the message says which.
  await stores.subscriptions.put(subscription({ status: "pending" }));
  await assert.rejects(enroll(), /no confirmed subscription to ledger \(pending\)/);
  assert.equal(starter.calls.length, 0);

  await stores.subscriptions.put(subscription());
  await enroll();
  assert.equal(starter.calls.length, 1, "and a confirmed subscription enrolls");
});

// ---------------------------------------------------------------------------
// A second enrollment retires the first (#245).
// ---------------------------------------------------------------------------

test("a re-signup mid-sequence supersedes the running enrollment", async () => {
  // The half of per-enrollment claim namespacing that makes it a fix rather than a
  // bug. Day 0: confirm, execution A starts with enrollmentId R1. Day 2: the
  // subscriber re-submits the signup form (pendingSubscription re-stamps
  // requestedAt) and confirms, so execution B starts under R2. A is still running,
  // holds a 365-day timeout, and cannot be cancelled — its name was derived from
  // an R1 nothing remembers. Its claims no longer collide with B's, so left alone
  // both would deliver every remaining step: the subscriber gets the whole welcome
  // sequence twice on two offset schedules. So A retires itself at its next step.
  const R1 = REQUESTED_AT;
  const R2 = "2027-03-09T09:00:00.000Z";
  const { stores } = await fixture(sequence());
  const seq = sequence();
  await stores.subscriptions.put(subscription());

  assert.equal(await enrollmentSuperseded(stores, seq, "s1", R1), false, "the current enrollment continues");

  await stores.subscriptions.put(
    subscription({ consent: { requestedAt: R2, confirmedAt: R2, basis: "explicit" } }),
  );
  assert.equal(await enrollmentSuperseded(stores, seq, "s1", R1), true, "the older execution must stop");
  assert.equal(await enrollmentSuperseded(stores, seq, "s1", R2), false, "the newer one carries on");
});

test("superseding is scoped: manual triggers, missing ids and other lists are left alone", async () => {
  const { stores } = await fixture();
  await stores.subscriptions.put(subscription());
  const moved = subscription({ consent: { requestedAt: "2028-01-01T00:00:00.000Z", basis: "explicit" } });

  // A manual enrollment's id is operator-supplied and has no relationship to any
  // subscription, so comparing it would retire every hand-enrolled sequence at its
  // first step.
  const manual = sequence({ trigger: { kind: "manual" } });
  assert.equal(await enrollmentSuperseded(stores, manual, "s1", "manual.1"), false);

  // An execution started before #245 has no identity to compare. The handler
  // echoes "" for it, so both shapes of absent must be inert.
  const seq = sequence();
  assert.equal(await enrollmentSuperseded(stores, seq, "s1", undefined), false);
  assert.equal(await enrollmentSuperseded(stores, seq, "s1", ""), false);

  // The TRIGGER list's subscription is the anchor, not the step's. A sequence
  // triggered by `ledger` whose step mails `dispatch` must not be retired because
  // `dispatch` was requested at a different moment.
  await stores.subscriptions.put({ ...moved, listId: "dispatch" });
  assert.equal(await enrollmentSuperseded(stores, seq, "s1", REQUESTED_AT), false);

  // And a vanished subscription is not evidence of a newer enrollment — that is
  // `evaluateDripStep`'s exit, with the right reason on it.
  assert.equal(await enrollmentSuperseded(stores, seq, "s2", REQUESTED_AT), false);
});

// ---------------------------------------------------------------------------
// The campaign id. SES's namespace, not ours.
// ---------------------------------------------------------------------------

test("a campaign id always fits in a SES message tag", () => {
  // `encodeTag` base64urls the campaign id into a SES message tag and SES caps a
  // tag value at 256 characters, so the id must stay under 192 bytes (four
  // characters per three bytes). Nothing downstream re-checks it: over the line,
  // SendEmail answers ValidationException, the claim is released, the step throws,
  // the Task exhausts its retries and the execution ends in DripFailed — every
  // step of the sequence, days after the enrollment returned 200. Reachable
  // because a manual enrollment carries an operator-supplied enrollmentId of up to
  // 128 characters, which even alongside ordinary ids is over budget.
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const long = "k".repeat(128);
  const worst = dripCampaignId("s".repeat(64), "p".repeat(64), long);
  assert.ok(b64(worst).length <= 256, `${b64(worst).length} chars of tag`);

  // The readable form survives everywhere it fits — including the signup path,
  // whose enrollmentId is an ISO timestamp.
  assert.equal(dripCampaignId("welcome", "day3", REQUESTED_AT), `drip:welcome#${REQUESTED_AT}#day3`);

  // Over budget the ENROLLMENT token is what gets digested: the sequence and step
  // stay readable because reporting groups on them, and the namespace is still one
  // per enrollment and still stable across retries of a step.
  const seqId = "s".repeat(40);
  const stepId = "p".repeat(40);
  const a = dripCampaignId(seqId, stepId, long);
  assert.equal(a, dripCampaignId(seqId, stepId, long), "stable, or a retried step re-sends");
  assert.notEqual(a, dripCampaignId(seqId, stepId, `${long}x`), "still one namespace per enrollment");
  assert.match(a, new RegExp(`^drip:${seqId}#[0-9a-f]{32}#${stepId}$`));

  // Ids past idSchema's 64 can only come from a sequence written straight to the
  // store, and must still produce something sendable rather than something SES
  // rejects.
  const absurd = dripCampaignId("s".repeat(300), "p".repeat(300), long);
  assert.ok(b64(absurd).length <= 256, `${b64(absurd).length} chars of tag`);
});

// ---------------------------------------------------------------------------
// The execution name. Step Functions' namespace, not ours.
// ---------------------------------------------------------------------------

const name = (over: Partial<Parameters<typeof dripExecutionName>[0]> = {}): string =>
  dripExecutionName({
    orgId: "summit",
    sequenceId: "welcome",
    subscriberId: "9f1c1a3e-0000-4000-8000-0123456789ab",
    enrollmentId: REQUESTED_AT,
    ...over,
  });

test("an execution name is readable, exact, and stable", () => {
  // Pinned as a literal, not a pattern: this string IS the idempotency key, so a
  // refactor that changes it silently re-enrolls every subscriber mid-sequence.
  assert.equal(name(), "drip.summit.welcome.2db6ca9a22c96055ddb232939f1849d5");
  assert.equal(name(), name(), "and it is derived, not random");
});

test("two orgs cannot collide on an execution name", () => {
  // `-` is legal INSIDE an id, so a `-` join would make org `acme` + sequence
  // `x-1` and org `acme-x` + sequence `1` one name — and then the second tenant's
  // enrollment is refused as a duplicate of the first. One org silently denying
  // enrollment to another, by accident or on purpose (#196, other namespace).
  assert.notEqual(
    name({ orgId: "acme", sequenceId: "x-1" }),
    name({ orgId: "acme-x", sequenceId: "1" }),
  );
});

test("every field is inside the name, including the ones that cannot be text", () => {
  // `subscriberId` and `enrollmentId` never appear literally — a UUID is 36 of
  // the 80 characters and an ISO timestamp contains colons, which Step Functions
  // rejects outright. They must still change the name, or two subscribers share
  // an execution and only one of them gets mail.
  assert.notEqual(name(), name({ subscriberId: "other-uuid" }));
  assert.notEqual(name(), name({ enrollmentId: "2028-01-05T08:00:00.000Z" }));
  assert.doesNotMatch(name(), /:/, "a colon would be rejected by StartExecution");
});

test("every id pair produces a legal Step Functions execution name", () => {
  // Step Functions caps the name at 80 and rejects whitespace, control characters
  // and `: / ? * " < > { } [ ] | ^ ~ $ # % & , ;`.
  const legal = /^[0-9a-zA-Z._-]{1,80}$/;
  const ids = ["a", "summit", "welcome-2026", "o".repeat(64), "x_y-z"];
  for (const orgId of ids) {
    for (const sequenceId of ids) {
      const n = name({ orgId, sequenceId });
      assert.match(n, legal, `${orgId}/${sequenceId} -> ${n} (${n.length} chars)`);
    }
  }
});

test("an oversized pair hashes instead of truncating, and still fits", () => {
  // Truncating the readable form would put the collision back at the cut point,
  // which is the whole failure this construction avoids.
  const a = name({ orgId: "o".repeat(64), sequenceId: "seq-a" });
  const b = name({ orgId: "o".repeat(64), sequenceId: "seq-b" });
  assert.ok(a.length <= 80 && b.length <= 80, "Step Functions caps execution names at 80");
  assert.notEqual(a, b, "two long pairs sharing a prefix must not collide");
});

test("an id outside the id charset never reaches the name as text", () => {
  // Nothing should hand us one — `idSchema` forbids it — but a sequence written
  // straight to the store can. Rejected characters must not be sanitized into
  // something lossy either: `drip:seq#3` and `drip-seq-3` must stay two names.
  const hostile = name({ sequenceId: "drip:seq#3" });
  assert.match(hostile, /^[0-9a-zA-Z._-]{1,80}$/);
  assert.notEqual(hostile, name({ sequenceId: "drip-seq-3" }));
});
