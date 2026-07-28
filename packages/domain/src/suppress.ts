/**
 * Bounce / complaint handling (docs/ARCHITECTURE.md §4.5, §4.13, §6).
 *
 * Hard bounces and complaints threaten the account/IP reputation shared by all
 * orgs, so they add a GLOBAL-scoped suppression entry (hybrid model), flip the
 * subscriber to `suppressed`, and mark the relevant subscription. This is what
 * the events processor calls on SES bounce/complaint notifications.
 */
import type { EngagementEvent, SubscriptionStatus, SuppressionSource } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

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
    scope: "global", // account-wide protection (§4.13)
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
