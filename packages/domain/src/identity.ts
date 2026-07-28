/**
 * Inbound identity sync from the main user pool / system of record (§4.3, #57).
 *
 * Email lives in a pool addressium deliberately never writes to, so it can't be
 * the join key. This applies add / email-change / delete events keyed by the
 * immutable Cognito `sub` (`externalId`). The email-change UX is: the person
 * updates their email on the main site (fully authenticated), and the site (or a
 * Cognito trigger) posts an `upsert` here with the same `externalId` and the new
 * email — we find the record by externalId and update the email attribute + its
 * index. First contact reconciles an existing email-only subscriber (created by
 * public signup before we knew the sub) and stamps its externalId.
 *
 * One-directional: this never writes back to the pool. The caller (services/api)
 * MUST verify the webhook signature first.
 */
import { schemas } from "@addressium/core";
import type { Subscriber } from "@addressium/core";
import { randomUUID } from "node:crypto";
import type { Clock, Stores, SubscriberAccountProvisioner } from "./ports.js";
import { eraseSubscriber } from "./privacy.js";

export type IdentityAction = "created" | "linked" | "updated" | "deleted" | "noop";

export interface IdentitySyncResult {
  action: IdentityAction;
  subscriberId?: string;
  email?: string;
}

export async function applyIdentitySync(
  stores: Stores,
  clock: Clock,
  raw: unknown,
): Promise<IdentitySyncResult> {
  const input = schemas.identitySyncSchema.parse(raw);

  if (input.action === "delete") {
    const existing = await stores.subscribers.findByExternalId(input.orgId, input.externalId);
    if (!existing) return { action: "noop" };
    // Reuse the GDPR erase path (anonymize PII + unsubscribe everywhere +
    // suppression tombstone), keyed by the record's current email.
    await eraseSubscriber(stores, clock, input.orgId, existing.email);
    return { action: "deleted", subscriberId: existing.sub };
  }

  const email = input.email!.trim().toLowerCase();

  // Prefer the stable external id; fall back to email to reconcile a subscriber
  // that public signup created before this person's Cognito sub was known.
  let subscriber = await stores.subscribers.findByExternalId(input.orgId, input.externalId);
  let action: IdentityAction;
  if (subscriber) {
    action = "updated";
  } else {
    subscriber = await stores.subscribers.findByEmail(input.orgId, email);
    action = subscriber ? "linked" : "created";
  }

  // An address that was suppressed must stay suppressed when the person changes
  // it (#193). Suppression is keyed by EMAIL while the subscriber is keyed by
  // `sub`, so without this the webhook silently makes a complainer mailable:
  // rename alice@old.com to alice@new.com and `isSuppressed` answers false for
  // an address whose owner filed a spam complaint.
  if (subscriber && subscriber.email !== email) {
    await carrySuppressionForward(stores, input.orgId, subscriber.email, email, clock);
  }

  const next: Subscriber = subscriber
    ? {
        ...subscriber,
        externalId: input.externalId,
        email,
        attributes: input.attributes ? { ...subscriber.attributes, ...input.attributes } : subscriber.attributes,
      }
    : {
        orgId: input.orgId,
        sub: randomUUID(),
        externalId: input.externalId,
        email,
        attributes: input.attributes ?? {},
        status: "active",
        entitlement: "free",
      };

  await stores.subscribers.put(next);
  return { action, subscriberId: next.sub, email };
}

/**
 * Copy an address's suppression entries onto its replacement (#193).
 *
 * The OLD entry is deliberately left in place. Removing it is the obvious
 * symmetric move and it is wrong in the direction that matters: if the rename is
 * itself the mistake — a bad identity feed, a mis-keyed webhook, an address
 * reused by a different person — deleting the tombstone makes a complainer
 * mailable again, which is the exact failure this function exists to prevent.
 * A stale suppression row costs one item and never sends an email; a deleted one
 * can.
 *
 * `addedAt` and `source` are preserved rather than restamped: "suppressed since
 * the complaint" is the fact a deliverability dispute turns on, and re-dating it
 * to the rename would erase the only evidence of when it happened.
 */
async function carrySuppressionForward(
  stores: Stores,
  orgId: string,
  oldEmail: string,
  newEmail: string,
  clock: Clock,
): Promise<void> {
  const entries = await stores.suppression.entriesFor(orgId, oldEmail);
  for (const entry of entries) {
    await stores.suppression.add({
      ...entry,
      email: newEmail,
      // The org the tombstone belongs to, not the org doing the rename — a
      // global entry must stay global, or the complaint stops covering the
      // other orgs that also hold this address.
      addedAt: entry.addedAt ?? clock.now().toISOString(),
    });
  }
}

/**
 * Provision a subscriber Cognito account (opt-in, #62) AFTER double opt-in, and
 * stamp the returned Cognito `sub` as the subscriber's externalId so the two
 * systems are linked. No-op if the subscriber is unknown or already linked.
 */
export async function provisionSubscriberAccount(
  stores: Stores,
  provisioner: SubscriberAccountProvisioner,
  orgId: string,
  poolId: string,
  subscriberId: string,
): Promise<Subscriber | undefined> {
  const subscriber = await stores.subscribers.get(orgId, subscriberId);
  if (!subscriber) return undefined;
  if (subscriber.externalId) return subscriber; // already linked to the pool
  const { externalId } = await provisioner.ensureAccount(poolId, subscriber.email);
  const updated: Subscriber = { ...subscriber, externalId };
  await stores.subscribers.put(updated);
  return updated;
}
