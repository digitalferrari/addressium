/**
 * Bounce / complaint handling (docs/ARCHITECTURE.md §4.5, §4.13, §6).
 *
 * Hard bounces and complaints threaten the account/IP reputation shared by all
 * orgs, so they add a GLOBAL-scoped suppression entry (hybrid model), flip the
 * subscriber to `suppressed`, and mark the relevant subscription. This is what
 * the events processor calls on SES bounce/complaint notifications.
 */
import type {
  EngagementEvent,
  SubscriptionStatus,
  SuppressionEntry,
  SuppressionScope,
  SuppressionSource,
} from "@addressium/core";
import type { Clock, Stores, SuppressedDestination, SuppressionChecker } from "./ports.js";

/**
 * Which sources threaten reputation the whole deployment shares, and therefore
 * scope GLOBAL rather than per-org (§4.13) — the one place this rule lives.
 *
 * `suppressAndFlip` below (the automatic SES-driven path) and `manualSuppress`
 * (`admin.ts`, #247 — an operator recording the same fact by hand) both consult
 * this rather than each hardcoding "global", so a human typing "this address
 * bounces" gets the identical scope an SES notification saying the same thing
 * would have produced. Getting this wrong in one direction lets a second org
 * mail an address the account already knows is toxic; wrong the other way
 * quietly narrows a real reputation signal to one org's problem.
 */
const GLOBAL_SUPPRESSION_SOURCES = new Set<SuppressionSource>(["bounce", "complaint"]);

export function scopeForSuppressionSource(source: SuppressionSource): SuppressionScope {
  return GLOBAL_SUPPRESSION_SOURCES.has(source) ? "global" : "org";
}

async function suppressAndFlip(
  stores: Stores,
  clock: Clock,
  input: {
    orgId: string;
    subscriberId: string;
    email: string;
    campaignId?: string;
    listId?: string;
  },
  source: Extract<SuppressionSource, "bounce" | "complaint">,
  subscriptionStatus: Extract<SubscriptionStatus, "bounced" | "complained">,
): Promise<void> {
  const now = clock.now().toISOString();

  await stores.suppression.add({
    orgId: input.orgId,
    email: input.email.toLowerCase(),
    source,
    scope: scopeForSuppressionSource(source), // always "global" for this caller — see the rule above
    addedAt: now,
  });

  const subscriber = await stores.subscribers.get(input.orgId, input.subscriberId);
  if (subscriber && subscriber.status !== "suppressed") {
    await stores.subscribers.put({ ...subscriber, status: "suppressed" });
  }

  if (input.listId) {
    const sub = await stores.subscriptions.get(input.orgId, input.subscriberId, input.listId);
    if (sub) {
      await stores.subscriptions.put({ ...sub, status: subscriptionStatus, updatedAt: now });
    }
  }

  if (input.campaignId) {
    const evt: EngagementEvent = {
      orgId: input.orgId,
      subscriberId: input.subscriberId,
      campaignId: input.campaignId,
      type: source === "bounce" ? "bounce" : "complaint",
      at: now,
    };
    await stores.events.append(evt);
  }
}

/** SES bounce classification (docs.aws.amazon.com SES event publishing). */
export type BounceType = "Permanent" | "Transient" | "Undetermined";

/**
 * Record a bounce, suppressing ONLY on a permanent one.
 *
 * A transient bounce is a full mailbox, greylisting, or a throttled receiver —
 * conditions that clear. Suppressing on those permanently kills a valid
 * subscriber, and because suppression is global (§4.13) it kills them across
 * every org. The gate lives here rather than in the events handler so the
 * guarantee is structural: a backfill, replay tool, webhook, or suppression
 * importer can't reintroduce the bug by forgetting to check (#211).
 *
 * `undefined` is treated as permanent to preserve the historical contract for
 * callers that genuinely don't know — SES always supplies the classification.
 */
export async function recordBounce(
  stores: Stores,
  clock: Clock,
  input: {
    orgId: string;
    subscriberId: string;
    email: string;
    campaignId?: string;
    listId?: string;
    bounceType?: BounceType;
  },
): Promise<{ suppressed: boolean }> {
  if (input.bounceType && input.bounceType !== "Permanent") {
    // Still record it: soft bounces must be visible, both for reporting and so
    // repeated-soft-bounce escalation can be built on real data later.
    if (input.campaignId) {
      await stores.events.append({
        orgId: input.orgId,
        subscriberId: input.subscriberId,
        campaignId: input.campaignId,
        type: "bounce",
        at: clock.now().toISOString(),
      });
    }
    return { suppressed: false };
  }
  await suppressAndFlip(stores, clock, input, "bounce", "bounced");
  return { suppressed: true };
}

export function recordComplaint(
  stores: Stores,
  clock: Clock,
  input: { orgId: string; subscriberId: string; email: string; campaignId?: string; listId?: string },
): Promise<void> {
  return suppressAndFlip(stores, clock, input, "complaint", "complained");
}

/** What checking one address turned up, from both sources of truth (#247). */
export interface SuppressionCheckResult {
  email: string;
  /** Our own store — org + global entries, exactly what `mayMail` consults. */
  local: SuppressionEntry[];
  /**
   * The provider's account list, live. `undefined` means the check could not be
   * made (no checker configured, or it threw) — NOT the same as "not
   * suppressed", which is `null`. Collapsing those two would tell an operator
   * an address is clear when the truth is that nobody asked.
   */
  live: SuppressedDestination | null | undefined;
  /** Set only when `live` is `undefined` because the check itself failed. */
  liveError?: string;
}

/**
 * Look up one address against both suppression records (#247) — the console
 * equivalent of `aws sesv2 get-suppressed-destination`, plus what our own send
 * path actually gates on.
 *
 * The two can legitimately disagree: SES auto-suppresses on its own schedule
 * from traffic outside this product (a different sender in the same account, an
 * operator using the SES console directly), and our local copy only moves when
 * OUR OWN pipeline sees a bounce/complaint or an operator acts. Showing one
 * without the other is the wrong answer either way — an operator staring at
 * "not suppressed locally" while SES is silently refusing every send is exactly
 * the confusion this exists to remove.
 *
 * The live half is best-effort: `checker` is optional (some callers only want
 * the local answer) and a throw degrades to `liveError` rather than failing the
 * whole lookup — a subscriber-detail page must still render on a throttled or
 * unreachable SES call.
 */
export async function checkSuppression(
  stores: Stores,
  checker: SuppressionChecker | undefined,
  orgId: string,
  email: string,
): Promise<SuppressionCheckResult> {
  const normalized = email.toLowerCase();
  const local = await stores.suppression.entriesFor(orgId, normalized);
  if (!checker) return { email: normalized, local, live: undefined };
  try {
    const live = await checker.get(normalized);
    return { email: normalized, local, live: live ?? null };
  } catch (e) {
    return { email: normalized, local, live: undefined, liveError: (e as Error).message };
  }
}
