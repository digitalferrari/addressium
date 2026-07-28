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

  // Unsubscribe everywhere, and strip the identifying half of each
  // subscription's consent record (#220). The timestamps and the basis stay:
  // they are the org's evidence that it was once entitled to mail this address,
  // which an erasure request does not retroactively undo. The IP, user agent
  // and source URL are personal data and go.
  const subs = await stores.subscriptions.listBySubscriber(orgId, subscriber.sub);
  for (const s of subs) {
    await stores.subscriptions.put({
      ...s,
      status: "unsubscribed",
      updatedAt: now,
      ...(s.consent
        ? {
            consent: {
              requestedAt: s.consent.requestedAt,
              ...(s.consent.confirmedAt ? { confirmedAt: s.consent.confirmedAt } : {}),
              ...(s.consent.basis ? { basis: s.consent.basis } : {}),
              ...(s.consent.importBatchId ? { importBatchId: s.consent.importBatchId } : {}),
            },
          }
        : {}),
    });
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
  //
  // Conditional on the rev read at the top (#194). This is a read-modify-write,
  // and a concurrent identity-sync upsert or CSV import landing in between would
  // RESTORE the PII — while this function returned `true` and the API told the
  // data subject their data was erased. A lost race must surface, not be
  // reported as success.
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
  }, { ifRev: subscriber.rev });
  return true;
}
