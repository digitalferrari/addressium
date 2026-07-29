/**
 * GDPR/CCPA data-subject requests (docs/ARCHITECTURE.md §4.19).
 *
 * Export returns the person's record. Erase removes every item that names them
 * and writes a tombstone, then reports what it actually did.
 *
 * **The old version anonymized exactly one DynamoDB item** (#164). Everything
 * else survived: the `externalId → sub` pointer, so `findByExternalId` still
 * resolved the erased person from their Cognito sub; the email-reservation item,
 * whose SORT KEY is the plaintext address; the entitlement record, linking them
 * to a billing system; and every engagement event bearing their subscriber id.
 * An operator ran the endpoint, got `true`, and reported compliance.
 *
 * Two things are deliberately KEPT, and both are lawful bases rather than
 * oversights:
 *
 * - **The suppression tombstone**, which holds the address. Retaining an address
 *   specifically to honour an opt-out is recognised under GDPR Art. 17(3)(b) /
 *   Recital 65, and without it the next import silently re-adds them.
 * - **Consent timestamps and basis** on each subscription. They are the org's
 *   evidence that it was once entitled to mail the address, which an erasure
 *   request does not retroactively undo. The IP, user agent and source URL —
 *   which are personal data — are stripped.
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

/**
 * What an erasure actually reached (#164).
 *
 * Returned instead of a bare `true` so the API, the audit log and the operator
 * all see the same account of the work. "It returned true" is what made the
 * original defect invisible: the answer was the same whether one item was
 * anonymized or every trace was removed.
 */
export interface ErasureReport {
  found: boolean;
  subscriberId?: string;
  /** Subscriptions unsubscribed and stripped of identifying consent fields. */
  subscriptionsRedacted: number;
  /** Engagement events deleted, across every campaign in the org. */
  eventsDeleted: number;
  /** The Cognito `sub` pointer was present and has been deleted. */
  externalIdRemoved: boolean;
  entitlementRemoved: boolean;
  emailReservationReleased: boolean;
  /**
   * The lake is NOT rewritten. Rows already written to S3 are compressed,
   * partitioned, append-only objects; a tombstone plus the bucket's expiry is
   * the mechanism, and this is the day the last of them can survive until.
   * Absent when the analytics tier is off, because then there is no lake.
   */
  lakeRowsExpireBy?: string;
}

/**
 * How long a row can survive in the fact tier before its lifecycle rule expires
 * it (docs/SECURITY.md §4.7). Kept next to the erasure so the number an operator
 * is told matches the rule that enforces it; the CDK default is the same value.
 */
export const LAKE_RETENTION_DAYS = 730;

export async function eraseSubscriber(
  stores: Stores,
  clock: Clock,
  orgId: string,
  email: string,
  opts: { analyticsEnabled?: boolean; lakeRetentionDays?: number } = {},
): Promise<ErasureReport> {
  const subscriber = await stores.subscribers.findByEmail(orgId, email);
  if (!subscriber) {
    return {
      found: false,
      subscriptionsRedacted: 0,
      eventsDeleted: 0,
      externalIdRemoved: false,
      entitlementRemoved: false,
      emailReservationReleased: false,
    };
  }
  const now = clock.now().toISOString();

  // ---- 1. the profile itself ----
  //
  // Done FIRST, and conditionally on the rev read above (#194). This is a
  // read-modify-write, and a concurrent identity-sync upsert or CSV import
  // landing in between would RESTORE the PII while this function reported
  // success. Doing it first also means that if anything below throws, the
  // profile is already anonymized rather than left intact by a half-run erasure.
  //
  // `externalId` is REMOVED, not spread through. The old projection spread
  // `...subscriber` and simply never mentioned it, so the Cognito sub — the most
  // durable identifier in the system — survived every erasure.
  const { externalId, ...withoutExternalId } = subscriber;
  await stores.subscribers.put(
    {
      ...withoutExternalId,
      email: `erased:${subscriber.sub}`,
      attributes: {},
      consent: undefined,
      status: "suppressed",
      entitlement: "free",
      entitlementAsof: undefined,
      source: undefined,
      locale: undefined,
    },
    { ifRev: subscriber.rev },
  );

  // ---- 2. the identity pointers ----
  if (externalId) await stores.subscribers.removeExternalIdPointer(orgId, externalId);
  await stores.subscribers.releaseEmail(orgId, subscriber.email);

  // ---- 3. subscriptions ----
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

  // ---- 4. entitlement + engagement history ----
  await stores.entitlements.remove(orgId, subscriber.sub);
  const eventsDeleted = await stores.events.deleteForSubscriber(orgId, subscriber.sub);

  // ---- 5. the suppression tombstone ----
  // Blocks a re-add (see signup()). Written AFTER the reservation is released,
  // so the two never disagree about whether the address is claimable.
  await stores.suppression.add({
    orgId,
    email: email.toLowerCase(),
    source: "manual",
    scope: "org",
    addedAt: now,
  });

  // ---- 6. the erasure tombstone ----
  // The lake's anti-join key. Rows already written to S3 cannot be deleted per
  // subject — they are compressed, partitioned, append-only objects — so every
  // analytics query filters against this instead, and the rows themselves age
  // out under the bucket's lifecycle rule.
  await stores.erasures.put({ orgId, subscriberId: subscriber.sub, erasedAt: now });

  const retention = opts.lakeRetentionDays ?? LAKE_RETENTION_DAYS;
  return {
    found: true,
    subscriberId: subscriber.sub,
    subscriptionsRedacted: subs.length,
    eventsDeleted,
    externalIdRemoved: Boolean(externalId),
    entitlementRemoved: true,
    emailReservationReleased: true,
    ...(opts.analyticsEnabled
      ? {
          lakeRowsExpireBy: new Date(
            clock.now().getTime() + retention * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }
      : {}),
  };
}
