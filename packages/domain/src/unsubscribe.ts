/**
 * Unsubscribe (docs/ARCHITECTURE.md §4.2, §4.13).
 *
 * Per-list unsubscribe simply flips the subscription to `unsubscribed` — the
 * sender only mails `confirmed` subscriptions, so no email-level suppression is
 * needed and other newsletters are unaffected. "Unsubscribe from all" flips
 * every subscription and records an org-scoped suppression entry.
 */
import type { Subscription, SuppressionSource } from "@addressium/core";
import { InvalidInputError, type Clock, type Stores } from "./ports.js";

export async function unsubscribeFromList(
  stores: Stores,
  clock: Clock,
  input: { orgId: string; subscriberId: string; listId: string },
): Promise<Subscription> {
  const sub = await stores.subscriptions.get(input.orgId, input.subscriberId, input.listId);
  if (!sub) throw new InvalidInputError("no such subscription");
  const updated: Subscription = {
    ...sub,
    status: "unsubscribed",
    updatedAt: clock.now().toISOString(),
  };
  await stores.subscriptions.put(updated);
  return updated;
}

export async function unsubscribeAllWithChanges(
  stores: Stores,
  clock: Clock,
  input: { orgId: string; subscriberId: string; email: string },
  /**
   * Why the address is being suppressed: a subscriber-initiated `"unsubscribe"`
   * (default) or an automated `"inactive"` sunset. Both are org-scoped and
   * self-clearable, so the person can re-opt-in later (#58).
   */
  source: Extract<SuppressionSource, "unsubscribe" | "inactive"> = "unsubscribe",
): Promise<{ count: number; changed: Subscription[] }> {
  const subs = await stores.subscriptions.listBySubscriber(input.orgId, input.subscriberId);
  const now = clock.now().toISOString();
  const changed: Subscription[] = [];
  for (const s of subs) {
    if (s.status !== "unsubscribed") {
      const updated = { ...s, status: "unsubscribed" as const, updatedAt: now };
      await stores.subscriptions.put(updated);
      changed.push(updated);
    }
  }
  // Unsubscribes are per-org in the hybrid suppression model (§4.13).
  await stores.suppression.add({
    orgId: input.orgId,
    email: input.email.toLowerCase(),
    source,
    scope: "org",
    addedAt: now,
  });
  return { count: changed.length, changed };
}

/** Backward-compatible count-only form used by non-delivery workflows. */
export async function unsubscribeAll(
  stores: Stores,
  clock: Clock,
  input: { orgId: string; subscriberId: string; email: string },
  source: Extract<SuppressionSource, "unsubscribe" | "inactive"> = "unsubscribe",
): Promise<number> {
  return (await unsubscribeAllWithChanges(stores, clock, input, source)).count;
}
