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

export function recordBounce(
  stores: Stores,
  clock: Clock,
  input: { orgId: string; subscriberId: string; email: string; campaignId?: string; listId?: string },
): Promise<void> {
  return suppressAndFlip(stores, clock, input, "bounce", "bounced");
}

export function recordComplaint(
  stores: Stores,
  clock: Clock,
  input: { orgId: string; subscriberId: string; email: string; campaignId?: string; listId?: string },
): Promise<void> {
  return suppressAndFlip(stores, clock, input, "complaint", "complained");
}
