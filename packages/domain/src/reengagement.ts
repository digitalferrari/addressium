/**
 * Engagement-based sunset + win-back automation (docs/ARCHITECTURE.md §4.22).
 *
 * List hygiene: subscribers who stop clicking hurt deliverability (ISPs weight
 * engagement), so once someone has gone quiet for `coldAfterDays` we enrol them
 * in a short win-back sequence. Each step is one email, spaced `stepIntervalDays`
 * apart. A click at any point graduates them back to engaged; if they never
 * click, the sequence ends by unsubscribing them from every list and suppressing
 * the address (`source: "inactive"`, org-scoped so they can re-opt-in later).
 *
 * Coldness is judged from `Subscriber.lastEngagedAt`, which the events processor
 * advances on CLICKS ONLY — opens are auto-fired by privacy proxies (Apple MPP)
 * and would keep dead addresses looking alive, so they are deliberately ignored.
 *
 * The decision (`decideReengagement`) is a pure function over one subscriber; the
 * sweep (`runReengagementSweep`) is the batch orchestrator a scheduled worker
 * runs (daily), reusing `sendToSubscriber` (suppression gate + per-step
 * idempotency) and `unsubscribeAll` (the sunset action).
 */
import type { Organization, ReengagementPolicy, Subscriber } from "@addressium/core";
import type { Clock, EmailSender, MagicLinkSigner, SendThrottle, Stores } from "./ports.js";
import type { EmailTemplate } from "./render.js";
import { sendToSubscriber } from "./send.js";
import { unsubscribeAll } from "./unsubscribe.js";

/** Sensible defaults; every field is per-org overridable via `Organization.reengagement`. */
/**
 * A policy with every decision field filled in.
 *
 * `listId` stays OPTIONAL (#233): it is the one field with no sensible default,
 * because the sweep sends real mail and has to send it from a list carrying a
 * from-address and a CAN-SPAM footer. Requiring it in the type would force a
 * placeholder; leaving it optional makes "enabled without a list" a condition the
 * dispatcher checks and reports, which is what an operator needs to see.
 */
export type ResolvedReengagementPolicy = Required<Omit<ReengagementPolicy, "listId">> & {
  listId?: string;
};

export const DEFAULT_REENGAGEMENT_POLICY: ResolvedReengagementPolicy = {
  enabled: false,
  coldAfterDays: 180,
  steps: 3,
  stepIntervalDays: 7,
  suppressScope: "org",
  // No default (#233). The sweep sends real mail and has to send it from a list
  // that carries a from-address and a CAN-SPAM footer; picking one would mail an
  // audience the operator did not choose.
};

/** Fill any omitted fields of a partial policy from the defaults. */
export function resolveReengagementPolicy(
  policy: Partial<ReengagementPolicy> | undefined,
): ResolvedReengagementPolicy {
  return { ...DEFAULT_REENGAGEMENT_POLICY, ...(policy ?? {}) };
}

/** Whole days elapsed between an ISO timestamp and `now` (floored, never negative). */
export function daysSince(iso: string, now: Date): number {
  const ms = now.getTime() - new Date(iso).getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
}

/**
 * The timestamp coldness is measured from: the last click if we have one, else
 * the consent time (when they opted in). Undefined means we have no basis to
 * judge — such subscribers are left alone rather than risk sunsetting someone we
 * simply never mailed.
 */
export function coldnessAnchor(sub: Subscriber): string | undefined {
  return sub.lastEngagedAt ?? sub.consent?.timestamp;
}

/**
 * The per-step sub-campaign id, so each win-back step's opens/clicks aggregate
 * on their own — and so the send claim is scoped to ONE enrollment (#207).
 *
 * `enrolledAt` is what makes each cycle its own claim namespace. Without it the
 * key was `reengagement:{listId}#{step}#{subscriberId}` with no notion of which
 * enrollment it belonged to, so a subscriber who went cold, ran the sequence,
 * clicked, graduated, and went cold again months later found every step's claim
 * already burned from the first cycle. They received ZERO win-back emails on the
 * second, and the enrollment never progressed.
 *
 * Idempotency within a cycle is unchanged: a redelivered sweep computes the same
 * `enrolledAt` and so the same key, and still sends each step at most once.
 */
export function reengagementCampaignId(
  listId: string,
  step: number,
  enrolledAt?: string,
): string {
  // Absent only for a subscriber enrolling right now, whose first step is being
  // claimed before the enrollment record exists. `new` is a distinct namespace
  // from any dated cycle, so it cannot collide with one.
  return `reengagement:${listId}#${enrolledAt ?? "new"}#${step}`;
}

export type ReengagementDecision =
  /** Not eligible: policy off, already suppressed, no confirmed lists, or no anchor. */
  | { action: "skip"; reason: string }
  /** Enrolled but the step spacing hasn't elapsed yet (or not cold yet). */
  | { action: "wait" }
  /** Send win-back email number `step` (1-based; step 1 is the enrollment send). */
  | { action: "send"; step: number }
  /** Clicked since enrolling — clear enrollment, back to engaged. */
  | { action: "graduate" }
  /** Sequence exhausted with no click — unsubscribe from all lists + suppress. */
  | { action: "sunset" };

export interface DecisionContext {
  subscriber: Subscriber;
  /** Does the subscriber have at least one non-unsubscribed subscription? */
  hasActiveSubscription: boolean;
  policy: ResolvedReengagementPolicy;
  now: Date;
}

/**
 * Decide the next win-back action for one subscriber. Pure — no IO — so the
 * whole state machine is unit-testable against a clock.
 */
export function decideReengagement(ctx: DecisionContext): ReengagementDecision {
  const { subscriber: s, hasActiveSubscription, policy, now } = ctx;
  if (!policy.enabled) return { action: "skip", reason: "disabled" };
  if (s.status === "suppressed") return { action: "skip", reason: "suppressed" };

  const re = s.reengagement;
  if (!re) {
    // Not yet enrolled — enroll only if cold and still reachable.
    if (!hasActiveSubscription) return { action: "skip", reason: "no active subscription" };
    const anchor = coldnessAnchor(s);
    if (!anchor) return { action: "skip", reason: "no engagement anchor" };
    if (daysSince(anchor, now) >= policy.coldAfterDays) return { action: "send", step: 1 };
    return { action: "skip", reason: "still warm" };
  }

  // Enrolled: a click after enrollment is a graduation, regardless of step.
  if (s.lastEngagedAt && s.lastEngagedAt > re.enrolledAt) return { action: "graduate" };
  // Respect the spacing between steps.
  if (daysSince(re.lastStepAt, now) < policy.stepIntervalDays) return { action: "wait" };
  // Spacing elapsed: either sunset (sequence done) or send the next step.
  if (re.stepsSent >= policy.steps) return { action: "sunset" };
  return { action: "send", step: re.stepsSent + 1 };
}

export interface ReengagementInput {
  orgId: string;
  /**
   * The flagship list the win-back emails send under and whose `fromAddress` is
   * used. Sunset still unsubscribes from ALL of the subscriber's lists.
   */
  listId: string;
  subject: string;
  template: EmailTemplate;
  throttle?: SendThrottle;
  /** Resume point from a previous invocation's result (#233). */
  cursor?: string;
  /**
   * Subscribers to examine in THIS invocation. Bounds the work so a large org
   * does not time out mid-pass — the caller re-invokes while a cursor comes back.
   * Default 1000.
   */
  maxSubscribers?: number;
}

export interface ReengagementSweepResult {
  /**
   * Where to resume (#233). Present means this invocation hit its budget with
   * work left; absent means the pass completed.
   */
  cursor?: string;
  scanned: number;
  enrolled: number;
  stepped: number;
  graduated: number;
  sunset: number;
  /** Step sends that did not go out, so the sequence did not advance (#181). */
  skipped?: number;
}

/**
 * Run one pass of the win-back automation for an org. Idempotent across runs:
 * step sends are gated by `sendToSubscriber`'s per-(campaign,subscriber) claim
 * and by the step-spacing check, so re-running the same day is a near no-op.
 */
export async function runReengagementSweep(
  stores: Stores,
  sender: EmailSender,
  magic: MagicLinkSigner | undefined,
  clock: Clock,
  input: ReengagementInput,
): Promise<ReengagementSweepResult> {
  const result: ReengagementSweepResult = { scanned: 0, enrolled: 0, stepped: 0, graduated: 0, sunset: 0 };

  const org: Organization | undefined = await stores.organizations.get(input.orgId);
  const policy = resolveReengagementPolicy(org?.reengagement);
  if (!policy.enabled) return result;

  const now = clock.now();
  const nowIso = now.toISOString();

  // ONE PAGE, resumed from a checkpoint (#233, #182).
  //
  // This used to be `subscribers.list(orgId)` — the entire org in memory, plus
  // an N+1 subscription read per subscriber, with no way to record progress. A
  // retry restarted from zero, so on an org large enough to matter the sweep
  // never completed: it burned the same first N subscribers on every attempt and
  // the tail was never swept at all.
  //
  // `budget` bounds one invocation. The caller re-invokes while a cursor comes
  // back, so a large org completes across several runs instead of timing out in
  // one.
  const budget = input.maxSubscribers ?? 1000;

  /** One subscriber's worth of the sweep. Extracted so paging stays readable. */
  const sweepOne = async (s: Subscriber): Promise<void> => {
    result.scanned++;
    const subs = await stores.subscriptions.listBySubscriber(input.orgId, s.sub);
    const hasActiveSubscription = subs.some((x) => x.status !== "unsubscribed");
    const decision = decideReengagement({ subscriber: s, hasActiveSubscription, policy, now });

    switch (decision.action) {
      case "send": {
        // Each step is its own sub-campaign so its engagement aggregates apart
        // and the idempotency claim is per step.
        const r = await sendToSubscriber(stores, sender, magic, clock, {
          orgId: input.orgId,
          // The CURRENT enrollment's stamp — a re-enrolled subscriber gets a
          // fresh claim namespace and therefore the whole sequence again.
          campaignId: reengagementCampaignId(input.listId, decision.step, s.reengagement?.enrolledAt),
          subscriberId: s.sub,
          listId: input.listId,
          subject: input.subject,
          template: input.template,
          throttle: input.throttle,
        });
        // Only advance the sequence if the message actually went out (#181).
        // Discarding this result meant a suppressed/already-claimed/unknown
        // recipient still progressed toward `sunset` — so a subscriber could be
        // unsubscribed from every list and suppressed WITHOUT ever being emailed.
        if (!r.sent) {
          result.skipped = (result.skipped ?? 0) + 1;
          break;
        }
        const reengagement =
          decision.step === 1
            ? { enrolledAt: nowIso, stepsSent: 1, lastStepAt: nowIso }
            : { ...s.reengagement!, stepsSent: decision.step, lastStepAt: nowIso };
        await stores.subscribers.put({ ...s, reengagement });
        if (decision.step === 1) result.enrolled++;
        else result.stepped++;
        break;
      }
      case "graduate": {
        await stores.subscribers.put({ ...s, reengagement: undefined });
        result.graduated++;
        break;
      }
      case "sunset": {
        await unsubscribeAll(
          stores,
          clock,
          { orgId: input.orgId, subscriberId: s.sub, email: s.email },
          "inactive",
        );
        await stores.subscribers.put({ ...s, reengagement: undefined, status: "suppressed" });
        result.sunset++;
        break;
      }
      // "wait" / "skip": nothing to do this pass.
    }
  };

  // Page until the budget is spent (#233, #182). One invocation does bounded
  // work and hands back a cursor; the caller resumes from it rather than
  // restarting, which is what makes the sweep finish on an org large enough to
  // need it.
  let cursor = input.cursor;
  do {
    const page = await stores.subscribers.page(input.orgId, {
      limit: Math.min(Math.max(budget - result.scanned, 1), 200),
      ...(cursor ? { cursor } : {}),
    });
    cursor = page.cursor;
    for (const s of page.items) await sweepOne(s);
  } while (cursor && result.scanned < budget);

  // A cursor in the result means "not finished". Absent means the pass completed,
  // and the caller clears the checkpoint on that.
  return { ...result, ...(cursor ? { cursor } : {}) };
}
