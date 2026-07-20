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
export const DEFAULT_REENGAGEMENT_POLICY: Required<ReengagementPolicy> = {
  enabled: false,
  coldAfterDays: 180,
  steps: 3,
  stepIntervalDays: 7,
  suppressScope: "org",
};

/** Fill any omitted fields of a partial policy from the defaults. */
export function resolveReengagementPolicy(
  policy: Partial<ReengagementPolicy> | undefined,
): Required<ReengagementPolicy> {
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

/** The per-step sub-campaign id, so each win-back step's opens/clicks aggregate on their own. */
export function reengagementCampaignId(listId: string, step: number): string {
  return `reengagement:${listId}#${step}`;
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
  policy: Required<ReengagementPolicy>;
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
}

export interface ReengagementSweepResult {
  scanned: number;
  enrolled: number;
  stepped: number;
  graduated: number;
  sunset: number;
}

/**
 * Run one pass of the win-back automation for an org. Idempotent across runs:
 * step sends are gated by `sendToSubscriber`'s per-(campaign,subscriber) claim
 * and by the step-spacing check, so re-running the same day is a near no-op.
 */
export async function runReengagementSweep(
  stores: Stores,
  sender: EmailSender,
  magic: MagicLinkSigner,
  clock: Clock,
  input: ReengagementInput,
): Promise<ReengagementSweepResult> {
  const result: ReengagementSweepResult = { scanned: 0, enrolled: 0, stepped: 0, graduated: 0, sunset: 0 };

  const org: Organization | undefined = await stores.organizations.get(input.orgId);
  const policy = resolveReengagementPolicy(org?.reengagement);
  if (!policy.enabled) return result;

  const now = clock.now();
  const nowIso = now.toISOString();
  const subscribers = await stores.subscribers.list(input.orgId);

  for (const s of subscribers) {
    result.scanned++;
    const subs = await stores.subscriptions.listBySubscriber(input.orgId, s.sub);
    const hasActiveSubscription = subs.some((x) => x.status !== "unsubscribed");
    const decision = decideReengagement({ subscriber: s, hasActiveSubscription, policy, now });

    switch (decision.action) {
      case "send": {
        // Each step is its own sub-campaign so its engagement aggregates apart
        // and the idempotency claim is per step.
        await sendToSubscriber(stores, sender, magic, clock, {
          orgId: input.orgId,
          campaignId: reengagementCampaignId(input.listId, decision.step),
          subscriberId: s.sub,
          listId: input.listId,
          subject: input.subject,
          template: input.template,
          throttle: input.throttle,
        });
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
  }

  return result;
}
