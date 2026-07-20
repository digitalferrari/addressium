/**
 * GDPR/CCPA data-subject requests (docs/ARCHITECTURE.md §4.19).
 *
 * Export returns the person's record; erase anonymizes the profile (removes PII),
 * unsubscribes them everywhere, and writes a suppression tombstone. Retaining a
 * suppression record specifically to honor an opt-out/erasure is a recognized
 * lawful basis, so the tombstone keeps the address on the suppression list.
 */
import type { EntitlementSync, Subscriber, Subscription } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

export interface SubjectExport {
  subscriber: Subscriber;
  subscriptions: Subscription[];
  entitlement?: EntitlementSync;
}

export async function exportSubscriber(
  stores: Stores,
  orgId: string,
  email: string,
): Promise<SubjectExport | undefined> {
  const subscriber = await stores.subscribers.findByEmail(orgId, email);
  if (!subscriber) return undefined;
  const subscriptions = await stores.subscriptions.listBySubscriber(orgId, subscriber.sub);
  const entitlement = await stores.entitlements.latest(orgId, subscriber.sub);
  return { subscriber, subscriptions, entitlement };
}

export async function eraseSubscriber(
  stores: Stores,
  clock: Clock,
  orgId: string,
  email: string,
): Promise<boolean> {
  const subscriber = await stores.subscribers.findByEmail(orgId, email);
  if (!subscriber) return false;
  const now = clock.now().toISOString();

  // Unsubscribe everywhere.
  const subs = await stores.subscriptions.listBySubscriber(orgId, subscriber.sub);
  for (const s of subs) {
    await stores.subscriptions.put({ ...s, status: "unsubscribed", updatedAt: now });
  }

  // Suppression tombstone (blocks re-add; see signup()).
  await stores.suppression.add({
    orgId,
    email: email.toLowerCase(),
    source: "manual",
    scope: "org",
    addedAt: now,
  });

  // Anonymize the profile — remove PII, keep the id so references stay valid.
  await stores.subscribers.put({
    ...subscriber,
    email: `erased:${subscriber.sub}`,
    attributes: {},
    consent: undefined,
    status: "suppressed",
    entitlement: "free",
    entitlementAsof: undefined,
    source: undefined,
    locale: undefined,
  });
  return true;
}
