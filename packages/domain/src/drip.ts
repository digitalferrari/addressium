/**
 * Drip / journey automations (docs/ARCHITECTURE.md §4.6, #23).
 *
 * A drip sequence is a list of steps, each with a wait and a send. The wait +
 * branching are orchestrated by a Step Functions state machine (Wait/Choice);
 * this module owns the pure per-step decision the machine calls at each Task
 * state: given the subscriber's current state, should this step SEND, be SKIPped
 * (gate not met, keep going), or EXIT the whole sequence (no confirmed
 * subscription to the step's list / unsubscribed / bounced / suppressed /
 * superseded by a newer enrollment). Keeping the choice logic here makes it
 * unit-testable and keeps the state machine a thin orchestrator.
 *
 * It also owns ENROLLMENT (#245): which sequences a confirmed signup enters, what
 * the first execution input is, and what the execution is named. Everything else
 * about drip existed — the machine, the step handler, the store, the console CRUD,
 * and `isEnrolledBySignup` right below — and NOTHING started an execution, so the
 * whole feature was reachable only from its own unit tests. The enrollment
 * decision lives here so it stays testable; the StartExecution call lives in
 * `adapters-aws/src/sfn.ts` so it stays thin.
 */
import { createHash } from "node:crypto";
import type { DripSequence, DripStep, Subscriber, Subscription } from "@addressium/core";
import type { DripEnrollment, DripStarter, Stores } from "./ports.js";

export type DripAction =
  | { type: "send"; step: DripStep }
  | { type: "skip"; reason: string }
  | { type: "exit"; reason: string };

/**
 * Decide what a step should do for one enrolled subscriber.
 *
 * The subscription is the step's ONLY proof that this person asked for mail on
 * `step.listId`, so nothing else in the send path re-checks it: `sendToSubscriber`
 * → `mayMail` looks at the subscriber's org-level status and the suppression
 * list, and never at the list subscription. A broadcast is safe without asking
 * because it derives its recipients FROM the list — it fans out over the sparse
 * confirmed index (`listConfirmed`), so consent is implicit in the audience. A
 * drip step is handed a bare `subscriberId` by the state machine instead, so it
 * is the one place that has to ask for itself. (The re-engagement sweep also
 * walks subscribers rather than a list, and its own gate is weaker —
 * `some(status !== "unsubscribed")`, which admits `pending`. Its win-back send is
 * a separate path with a separate decision function; noted so this comment is not
 * read as a claim about it.)
 *
 * Hence `confirmed`, and nothing else, sends (#245). This used to exit only on
 * `unsubscribed`/`bounced`/`complained`, which meant a MISSING subscription and a
 * `pending` one both fell through to `send`: a hand-enrolled subscriber, or a
 * sequence whose step list differs from its trigger list, would have been mailed
 * marketing on a list they never confirmed — and someone still sitting at
 * `pending` would have received it before finishing double opt-in. Unreachable
 * while nothing started executions; live the moment enrollment existed.
 *
 * `exit` rather than `skip`, matching how this function has always treated a
 * per-list status: the subscription for the step's list is the sequence's
 * anchor, and a sequence advancing on the hope that someone confirms a list
 * mid-flight would keep a 365-day execution alive to send them mail they did not
 * ask for at a moment nobody chose. A sequence whose steps span several lists
 * therefore needs each of them confirmed, not just the trigger's.
 */
export function evaluateDripStep(
  step: DripStep,
  subscriber: Subscriber | undefined,
  subscription: Subscription | undefined,
): DripAction {
  if (!subscriber) return { type: "exit", reason: "subscriber not found" };
  if (subscriber.status === "suppressed") return { type: "exit", reason: "suppressed" };
  if (!subscription) return { type: "exit", reason: `no subscription to ${step.listId}` };
  if (subscription.status !== "confirmed") {
    return { type: "exit", reason: `subscription ${subscription.status}` };
  }
  if (step.requireEntitlement && subscriber.entitlement !== step.requireEntitlement) {
    return { type: "skip", reason: `entitlement ${subscriber.entitlement} != ${step.requireEntitlement}` };
  }
  return { type: "send", step };
}

/** The index of the next step, or undefined when the sequence is complete. */
export function nextStepIndex(sequence: DripSequence, currentIndex: number): number | undefined {
  const next = currentIndex + 1;
  return next < sequence.steps.length ? next : undefined;
}

/** Whether a signup on `listId` should enroll the subscriber in this sequence. */
export function isEnrolledBySignup(sequence: DripSequence, listId: string): boolean {
  return sequence.trigger.kind === "signup" && sequence.trigger.listId === listId;
}

// ---------------------------------------------------------------------------
// Enrollment (#245)
// ---------------------------------------------------------------------------

/** Step Functions caps an execution name at 80 characters. */
const EXECUTION_NAME_MAX = 80;
/** Enough sha256 to make an accidental collision impossible in practice. */
const DIGEST_CHARS = 32;
const NAME_PREFIX = "drip";
/** What is left for the readable `<org>.<sequence>` part after prefix + digest. */
const READABLE_MAX = EXECUTION_NAME_MAX - NAME_PREFIX.length - DIGEST_CHARS - 2;
/**
 * Ids we are willing to put in READABLE text: exactly what `idSchema` allows.
 * Anything else falls back to the digest-only form rather than being sanitized
 * into something lossy — `drip:seq#3` and `drip-seq-3` must not become one name.
 */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/;
/**
 * How long a campaign id may be before SES refuses to send it.
 *
 * `encodeTag` base64urls the campaign id into a SES message tag, SES caps a tag
 * value at 256 characters, and base64url is four characters per three bytes:
 * 256 / 4 * 3 = 192. Nothing downstream re-checks this, and the symptom is a
 * `ValidationException` on every send of the sequence.
 */
const CAMPAIGN_ID_MAX_BYTES = 192;

/** The truncated sha256 both derived identifiers here fall back to. */
const shortDigest = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, DIGEST_CHARS);

/**
 * The Step Functions execution name for one enrollment (#245).
 *
 * The name is the ONLY idempotency mechanism on this path: `StartExecution` with
 * a name that matches a running execution (and an identical input) is a no-op,
 * which is what makes a triple-clicked confirmation link enroll once. So it must
 * be derived, never random, and it must be different for a genuine re-enrollment.
 *
 * Two constraints shape the construction, and neither tolerates the obvious
 * concatenation:
 *
 *   - **80 characters.** `subscriberId` alone is a 36-char `randomUUID`, and
 *     `orgId`/`sequenceId` are up to 64 each, so a readable join blows the budget
 *     on ordinary input rather than on an edge case.
 *   - **Charset.** Step Functions rejects whitespace, control characters and
 *     ``: / ? * " < > { } [ ] | ^ ~ $ # % & , ;``. `enrollmentId` is an ISO
 *     timestamp, so its colons make it unembeddable as text, full stop.
 *
 * Hence: the digest carries the whole tuple, and the readable prefix is a
 * courtesy for whoever reads the executions list. `.` separates because
 * `idSchema` forbids it inside an id, which is what makes the join unambiguous —
 * `-` is legal INSIDE an id, so joining on `-` would let org `acme` + sequence
 * `x-1` and org `acme-x` + sequence `1` produce one name (#196, same bug, other
 * namespace). Over budget the readable part is replaced WHOLESALE; truncating it
 * would put the collision back at the cut point.
 *
 * Operational consequence worth knowing: Step Functions keeps closed execution
 * names for 90 days, so re-running the SAME enrollment inside that window is
 * refused (`ExecutionAlreadyExists`) rather than duplicated. That is the
 * behaviour we want when the execution holding the name is running or completed,
 * and it is why the adapter treats those as success — but a closed execution that
 * FAILED delivered nothing and cannot be restarted under this name, so the adapter
 * reads the status rather than assuming (see `SfnDripStarter`).
 */
export function dripExecutionName(e: {
  orgId: string;
  sequenceId: string;
  subscriberId: string;
  enrollmentId: string;
}): string {
  // NUL between the parts so ("ab","c") and ("a","bc") hash differently — the
  // same ambiguity as above, one layer down.
  const digest = shortDigest([e.orgId, e.sequenceId, e.subscriberId, e.enrollmentId].join("\u0000"));
  const readable = `${e.orgId}.${e.sequenceId}`;
  if (readable.length > READABLE_MAX || !SAFE_ID.test(e.orgId) || !SAFE_ID.test(e.sequenceId)) {
    return `${NAME_PREFIX}.${digest}`;
  }
  return `${NAME_PREFIX}.${readable}.${digest}`;
}

/** The sentinel `enrollmentId` for a subscription that predates consent provenance. */
export const LEGACY_ENROLLMENT_ID = "legacy";

/**
 * The per-step sub-campaign id — so each step's opens/clicks aggregate on their
 * own, and so the send claim is scoped to ONE enrollment (#245).
 *
 * Getting the execution name right stops a double enrollment; this stops a
 * genuine RE-enrollment from silently sending nothing. The send claim is a
 * permanent conditional Put with no TTL, so `drip-<sequence>-<step>` — the old
 * key, with no notion of which enrollment it belonged to — was burned for good by
 * the first run. A subscriber who signed up, received the welcome sequence,
 * unsubscribed, and came back a year later would start a fresh execution that
 * marched through every step finding the claim already taken and emailed them
 * nothing at all. That is #207 exactly, one automation over, and
 * `reengagementCampaignId` fixed it there the same way.
 *
 * Idempotency WITHIN a run is unchanged: a retried step computes the same id and
 * still sends at most once.
 *
 * The length cap is not cosmetic. A campaign id becomes a SES message tag
 * (`encodeTag`, adapters-aws/src/ses.ts), and SES restricts tag values to 256
 * characters of `[A-Za-z0-9_-]` — which is why they are base64url, four characters
 * per three bytes. So an id over 192 bytes is a `ValidationException` from
 * `SendEmail`: the claim is released, the step throws, the Task exhausts its four
 * retries and the execution ends in `DripFailed`. Every step of the sequence, and
 * the operator finds out days after the enrollment returned 200. Reachable because
 * a manual enrollment carries an operator-supplied `enrollmentId` of up to 128
 * characters (`enrollDripSequenceSchema`) — and even a 64-char cap would not save
 * it alongside two 64-char ids. Over budget, the enrollment token is replaced by
 * its digest: still one namespace per enrollment, still stable across retries of a
 * step, and short enough to send.
 */
export function dripCampaignId(sequenceId: string, stepId: string, enrollmentId?: string): string {
  // Absent only for an execution started before enrollment ids existed. Those
  // keep the original key so an in-flight sequence is not silently restarted
  // mid-way with a clean claim namespace.
  if (!enrollmentId) return `drip-${sequenceId}-${stepId}`;
  const readable = `drip:${sequenceId}#${enrollmentId}#${stepId}`;
  if (Buffer.byteLength(readable, "utf8") <= CAMPAIGN_ID_MAX_BYTES) return readable;
  // The enrollment token is the only unbounded part on the manual route, so digest
  // it first and keep the sequence and step readable — reporting groups on them.
  const scoped = `drip:${sequenceId}#${shortDigest(enrollmentId)}#${stepId}`;
  if (Buffer.byteLength(scoped, "utf8") <= CAMPAIGN_ID_MAX_BYTES) return scoped;
  // Only reachable from a sequence written straight to the store with ids past
  // `idSchema`'s 64: digest the lot rather than hand SES something it rejects.
  return `drip:${shortDigest(readable)}`;
}

/**
 * Which enrollment a confirmed subscription represents (#245).
 *
 * `consent.requestedAt` is the only field on a `Subscription` with the two
 * properties enrollment identity needs, and the choice is load-bearing:
 *
 *   - **Stable across retries.** `confirmOptInAny` preserves it (it is written
 *     BEFORE the spread of the stored consent), so clicking the confirmation link
 *     three times yields one id and one execution.
 *   - **New for a new subscription.** `pendingSubscription` overwrites it with
 *     `now` (written AFTER the spread), so an unsubscribe → re-signup → confirm
 *     cycle is a genuinely new enrollment and runs the sequence again.
 *
 * `consent.confirmedAt` and `Subscription.updatedAt` are both re-stamped with
 * `now` on EVERY confirmation call — they sit on the object this function is
 * handed, which makes them tempting and wrong. Either one would mint a fresh id
 * per click and enroll a triple-clicker three times.
 *
 * Consent is optional (a pre-#220 record has none), so those subscriptions share
 * one sentinel. A literal is the honest fallback: it enrolls them once, forever,
 * rather than silently keying off a volatile field.
 *
 * One behavioural note that travels with this choice: a subscriber who re-submits
 * the signup form while already confirmed gets a fresh `requestedAt`
 * (`pendingSubscription` flips them back to `pending`), so their next confirmation
 * IS a new enrollment. That is a new explicit opt-in request, so re-running the
 * welcome sequence is defensible — but it is a decision, not an accident, and it
 * can happen MID-SEQUENCE, with the first execution still running and no way to
 * cancel it. `enrollmentSuperseded` below is what stops that being a
 * deliver-everything-twice bug; read the two together. The
 * preference-centre re-subscribe path is the opposite: it INHERITS the original
 * `requestedAt`, so if enrollment is ever wired there, a subscriber who leaves and
 * returns through the preference centre would never re-enroll. Enrollment is
 * deliberately scoped to the double-opt-in path and explicit manual enrollment.
 */
export function enrollmentIdFor(subscription: Subscription): string {
  return subscription.consent?.requestedAt ?? LEGACY_ENROLLMENT_ID;
}

/**
 * Has a NEWER enrollment taken this sequence over from the running one? (#245)
 *
 * This is the other half of keying enrollment on `consent.requestedAt`, and
 * without it the per-enrollment claim namespace is a duplicate-send bug rather
 * than a fix. A subscriber signs up, confirms, and execution A begins a sequence
 * with steps on day 3, 10 and 30. On day 5 they submit the signup form again —
 * from another landing page, or because they forgot — and confirm: `requestedAt`
 * has moved, so that is a different enrollment, a different execution name, and
 * execution B starts. A is still running, holds a 365-day timeout, and cannot be
 * cancelled: its previous `requestedAt` was overwritten at signup, so nothing
 * knows the name to stop. And because each enrollment now claims its sends under
 * its own `dripCampaignId`, the two do NOT collide — so both would run to the end
 * and the subscriber would receive every remaining step twice, on two offset
 * schedules.
 *
 * So the older execution retires itself. Each step asks whether the enrollment it
 * was started for is still the current one for the sequence's TRIGGER list — the
 * same subscription, and the same field, that minted it — and exits if not. The
 * newest enrollment always wins, whatever order the executions wake in, and no
 * `StopExecution`, no execution bookkeeping and no extra IAM is involved.
 *
 * Deliberately narrow, on three counts:
 *
 *   - **Signup triggers only.** A manual enrollment's id is operator-supplied and
 *     has no relationship to any subscription, so this test would exit every step
 *     of every hand-enrolled sequence at once.
 *   - **The trigger list, not the step's list.** A step may target another list
 *     whose own `requestedAt` is unrelated; comparing against it would retire
 *     healthy sequences. `evaluateDripStep` is what gates the step's own list.
 *   - **Only when the run HAS an enrollment id.** An execution started before
 *     #245 carries none (and the handler echoes `""`), and has no identity to
 *     compare — those finish as they began.
 */
export async function enrollmentSuperseded(
  stores: Stores,
  sequence: DripSequence,
  subscriberId: string,
  enrollmentId: string | undefined,
): Promise<boolean> {
  if (sequence.trigger.kind !== "signup") return false;
  if (!enrollmentId) return false;
  const anchor = await stores.subscriptions.get(sequence.orgId, subscriberId, sequence.trigger.listId);
  // No subscription at all is not evidence of a newer enrollment — it is evidence
  // of a deleted one, which `evaluateDripStep` already exits on for the step's own
  // list. Answering "superseded" here would give that the wrong reason.
  if (!anchor) return false;
  return enrollmentIdFor(anchor) !== enrollmentId;
}

/**
 * The first execution input for a sequence, or undefined if it cannot be started.
 *
 * A sequence with no steps is skipped rather than started: the machine would wait
 * `nextWaitSeconds` and then invoke the step handler for step 0 of an empty list,
 * which returns "no such step" and Succeeds — an execution whose entire life is to
 * prove it had nothing to do. The API schema requires `.min(1)` step, so this only
 * catches a sequence written directly to the store, but that is exactly the input
 * no schema is guarding.
 */
export function initialEnrollment(
  sequence: DripSequence,
  subscriberId: string,
  enrollmentId: string,
): DripEnrollment | undefined {
  const first = sequence.steps[0];
  if (!first) return undefined;
  return {
    orgId: sequence.orgId,
    sequenceId: sequence.sequenceId,
    subscriberId,
    // The machine starts at the WAIT (#201), so step 0's own wait is honored:
    // "three days after signup" waits three days instead of firing at signup.
    nextStepIndex: 0,
    nextWaitSeconds: first.waitSeconds ?? 0,
    enrollmentId,
  };
}

/**
 * Start every sequence in `sequences` that a signup on `listId` triggers.
 *
 * Private, and there is deliberately no exported single-list variant: an exported
 * enrollment function whose only caller is a test is how #245 happened.
 */
async function startMatching(
  starter: DripStarter,
  sequences: DripSequence[],
  input: { subscriberId: string; listId: string; enrollmentId: string },
): Promise<DripEnrollment[]> {
  const started: DripEnrollment[] = [];
  for (const sequence of sequences) {
    // The predicate that already existed and had no caller outside its own unit
    // test. This is the call it was written for.
    if (!isEnrolledBySignup(sequence, input.listId)) continue;
    const enrollment = initialEnrollment(sequence, input.subscriberId, input.enrollmentId);
    if (!enrollment) continue;
    // Sequentially and without a guard on what was already started: the starter
    // is idempotent by execution name, so ordering cannot matter and a duplicate
    // is a no-op rather than an error. Nothing here needs to remember anything.
    await starter.start(enrollment);
    started.push(enrollment);
  }
  return started;
}

/**
 * Enroll for every subscription a double opt-in just confirmed (#245).
 *
 * `confirmOptInAny` returns ALL of them — a batch signup mints one token carrying
 * every listId, so one click can confirm three lists and trigger three different
 * sequences. Looking at `subs[0]` would enroll for whichever list happened to be
 * first in the token and silently drop the rest.
 *
 * The return array is IDENTICAL on the first click and the third (an
 * already-confirmed subscription is re-written and re-returned, with no signal
 * distinguishing the two), so it carries no first-time information and none is
 * used: idempotency comes entirely from the derived execution name.
 *
 * Reads each org's whole sequence partition and filters in memory. There is no
 * index on `trigger.listId` and this does not warrant one: sequences are
 * operator-authored, there are a handful per org, and `list` is a
 * single-partition query. Said out loud so it is a decision rather than something
 * to re-litigate.
 */
export async function enrollOnConfirmation(
  stores: Stores,
  starter: DripStarter,
  subscriptions: Subscription[],
): Promise<DripEnrollment[]> {
  const sequencesByOrg = new Map<string, DripSequence[]>();
  const started: DripEnrollment[] = [];
  for (const subscription of subscriptions) {
    // One store read per ORG, not per list: every list in one confirmation token
    // belongs to the same org, so a three-list batch signup is one query.
    let sequences = sequencesByOrg.get(subscription.orgId);
    if (!sequences) {
      sequences = await stores.dripSequences.list(subscription.orgId);
      sequencesByOrg.set(subscription.orgId, sequences);
    }
    started.push(
      ...(await startMatching(starter, sequences, {
        subscriberId: subscription.subscriberId,
        listId: subscription.listId,
        enrollmentId: enrollmentIdFor(subscription),
      })),
    );
  }
  return started;
}

/**
 * Enroll a subscriber into one sequence by hand (#245) — the operator path for
 * `trigger.kind === "manual"`.
 *
 * A signup-triggered sequence is refused rather than started. `trigger` declares
 * how a sequence is ENTERED, and a signup sequence's enrollment identity is the
 * subscriber's opt-in request; hand-starting one would run it under an
 * operator-supplied identity alongside the real one, so the same person could sit
 * in the same sequence twice with two claim namespaces and receive every step
 * twice. An operator who wants a hand-enrollable sequence sets its trigger to
 * `manual`.
 *
 * Consent is checked HERE as well as at every step. This route takes a bare
 * `subscriberId` — unlike a broadcast, which derives its recipients from the
 * list's confirmed set — so without this an operator could aim a sequence at
 * somebody who never joined the list it mails, and the only thing standing in the
 * way would be `evaluateDripStep` exiting one Wait later, with a 200 already
 * returned and nobody watching. Refusing at the door makes it an answer rather
 * than a silence.
 */
export async function enrollManually(
  stores: Stores,
  starter: DripStarter,
  input: { orgId: string; sequenceId: string; subscriberId: string; enrollmentId: string },
): Promise<DripEnrollment> {
  const sequence = await stores.dripSequences.get(input.orgId, input.sequenceId);
  if (!sequence) throw new Error(`unknown drip sequence ${input.sequenceId}`);
  if (sequence.trigger.kind !== "manual") {
    throw new Error(`drip sequence ${input.sequenceId} is ${sequence.trigger.kind}-triggered, not manual`);
  }
  const enrollment = initialEnrollment(sequence, input.subscriberId, input.enrollmentId);
  if (!enrollment) throw new Error(`drip sequence ${input.sequenceId} has no steps`);
  // `initialEnrollment` returned, so step 0 exists.
  const listId = sequence.steps[0]!.listId;
  const subscription = await stores.subscriptions.get(input.orgId, input.subscriberId, listId);
  if (subscription?.status !== "confirmed") {
    throw new Error(
      `subscriber ${input.subscriberId} has no confirmed subscription to ${listId}` +
        `${subscription ? ` (${subscription.status})` : ""}`,
    );
  }
  await starter.start(enrollment);
  return enrollment;
}
