/**
 * Admin subscriber detail and editing (#205, docs/ARCHITECTURE.md §4.12).
 *
 * The Subscribers screen was read-plus-destructive-only: search, "unsubscribe
 * all", suppress, lift. There was no way to see a subscriber's ATTRIBUTES — the
 * merge-tag values that drive every personalised send — and no way to opt them
 * into or out of ONE list. Test setup and support both required direct DynamoDB
 * access, which is the sort of gap that gets worked around rather than reported.
 *
 * Two rules run through everything here:
 *
 * 1. **Manual confirmation bypasses double opt-in**, so it is never a side
 *    effect. It is its own action, refused unless the caller says explicitly
 *    that they mean it, and the consent it writes records that a human did it —
 *    never a fabricated source URL that would read like a real signup.
 * 2. **Suppression outranks every opt-in.** Nothing here can un-suppress an
 *    address; that is `liftSuppression`'s job and its own capability.
 */
import type { Subscriber, Subscription, SubscriptionStatus } from "@addressium/core";
import { schemas } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

/** One list, with this subscriber's standing on it. */
export interface SubscriberListState {
  listId: string;
  name: string;
  /** Absent when the subscriber has never been on this list. */
  status?: SubscriptionStatus;
  updatedAt?: string;
  /** How consent for this list was obtained, when it was recorded (#220). */
  consent?: Subscription["consent"];
}

/** Everything the console's subscriber detail view shows (#205). */
export interface SubscriberDetail {
  orgId: string;
  sub: string;
  email: string;
  status: "active" | "suppressed";
  entitlement: "free" | "paid";
  lastEngagedAt?: string;
  externalId?: string;
  attributes: Record<string, string>;
  /** Every list in the org, whether or not this subscriber is on it. */
  lists: SubscriberListState[];
  /** Explicit-membership segments (#203) naming this subscriber. */
  segments: { segmentId: string; name: string }[];
  /**
   * True when the send path will skip this address whatever the opt-ins say.
   * Shown because an operator who cannot see it concludes the send is broken.
   */
  suppressed: boolean;
}

/**
 * The full record behind one row of the Subscribers screen (#205).
 *
 * Lists the org's lists — not just the ones with a subscription — because "not
 * subscribed" is the state an operator most often wants to change, and a list
 * that does not appear cannot be opted into.
 *
 * Rule-based segments are deliberately NOT evaluated here. Doing so would mean
 * running every predicate in the org against one subscriber on every detail
 * view, and the answer is a moving target that changes without anyone editing
 * anything. Explicit cohorts are enumerable and stable, so those are shown.
 */
export async function subscriberDetail(
  stores: Stores,
  orgId: string,
  sub: string,
): Promise<SubscriberDetail> {
  const subscriber = await stores.subscribers.get(orgId, sub);
  if (!subscriber) throw new Error(`unknown subscriber ${sub}`);

  const [lists, subscriptions, segments] = await Promise.all([
    stores.lists.list(orgId),
    stores.subscriptions.listBySubscriber(orgId, sub),
    stores.segments.list(orgId),
  ]);
  const bySubList = new Map(subscriptions.map((s) => [s.listId, s]));

  return {
    orgId,
    sub: subscriber.sub,
    email: subscriber.email,
    status: subscriber.status,
    entitlement: subscriber.entitlement,
    ...(subscriber.lastEngagedAt ? { lastEngagedAt: subscriber.lastEngagedAt } : {}),
    ...(subscriber.externalId ? { externalId: subscriber.externalId } : {}),
    attributes: { ...subscriber.attributes },
    lists: lists.map((l) => {
      const s = bySubList.get(l.listId);
      return {
        listId: l.listId,
        name: l.name,
        ...(s ? { status: s.status, updatedAt: s.updatedAt } : {}),
        ...(s?.consent ? { consent: s.consent } : {}),
      };
    }),
    segments: segments
      .filter((seg) => {
        const p = seg.predicate as { match?: unknown; subscriberIds?: unknown };
        return p?.match === "explicit" && Array.isArray(p.subscriberIds) && p.subscriberIds.includes(sub);
      })
      .map((seg) => ({ segmentId: seg.segmentId, name: seg.name })),
    // Both halves, exactly as `mayMail` checks them (#193).
    suppressed:
      subscriber.status === "suppressed" ||
      (await stores.suppression.isSuppressed(orgId, subscriber.email)),
  };
}

/**
 * Replace a subscriber's attributes (#205).
 *
 * A full replacement, not a merge: a merge cannot express "remove this
 * attribute", and the console edits the whole map anyway. Validated through the
 * same `attributesSchema` the unauthenticated signup path uses (#196) — an admin
 * screen is a lower-volume way to reach the same 400 KB item.
 *
 * Attributes are merge-tag VALUES. They are escaped at render (`render.ts`), not
 * here: sanitising on the way in would corrupt a legitimate `Tom & Jerry` and
 * would still leave the values already in the table unescaped.
 */
export async function setSubscriberAttributes(
  stores: Stores,
  input: { orgId: string; sub: string; attributes: Record<string, string> },
): Promise<SubscriberDetail> {
  const subscriber = await stores.subscribers.get(input.orgId, input.sub);
  if (!subscriber) throw new Error(`unknown subscriber ${input.sub}`);
  const attributes = schemas.attributesSchema.parse(input.attributes);

  const updated: Subscriber = { ...subscriber, attributes };
  // Conditional on the rev we just read (#194): the console edits the whole map,
  // so two operators saving concurrently would otherwise silently discard one
  // set of edits rather than telling the loser to reload.
  await stores.subscribers.put(updated, { ifRev: subscriber.rev });
  return subscriberDetail(stores, input.orgId, input.sub);
}

/**
 * Set one subscription's status (#205).
 *
 * `confirmed` is the dangerous one: it asserts a double opt-in that never
 * happened. It is refused unless `acknowledgeManualConfirmation` is true, so it
 * can never be reached by a mis-click on a dropdown or by a client that forgot
 * the flag. The caller (the API handler) audits it.
 *
 * The consent written for a manual confirmation says what actually happened —
 * `basis: "manual_admin"` with the acting member's id. Writing a plausible
 * source URL instead would make an administrative act indistinguishable from a
 * real signup in exactly the record a consent dispute turns on.
 */
export async function setSubscriptionStatus(
  stores: Stores,
  clock: Clock,
  input: {
    orgId: string;
    sub: string;
    listId: string;
    status: SubscriptionStatus;
    acknowledgeManualConfirmation?: boolean;
    /** The acting admin, for the consent record. Never taken from a request body. */
    actor?: string;
  },
): Promise<SubscriberDetail> {
  const subscriber = await stores.subscribers.get(input.orgId, input.sub);
  if (!subscriber) throw new Error(`unknown subscriber ${input.sub}`);
  const list = await stores.lists.get(input.orgId, input.listId);
  if (!list) throw new Error(`unknown list ${input.listId}`);

  if (input.status === "confirmed" && !input.acknowledgeManualConfirmation) {
    throw new Error(
      "manually confirming a subscription bypasses double opt-in — resend the request with acknowledgeManualConfirmation",
    );
  }

  const now = clock.now().toISOString();
  const existing = await stores.subscriptions.get(input.orgId, input.sub, input.listId);
  const subscription: Subscription = {
    orgId: input.orgId,
    subscriberId: input.sub,
    listId: input.listId,
    status: input.status,
    updatedAt: now,
    // Existing provenance is never overwritten — it is the proof of the ORIGINAL
    // opt-in, and an admin action is not a better version of it.
    ...(existing?.consent
      ? { consent: existing.consent }
      : input.status === "confirmed"
        ? {
            consent: {
              basis: "manual_admin" as const,
              // The admin action IS the request and the confirmation — there was
              // no separate opt-in to point at, and inventing two timestamps
              // would imply a flow that did not happen.
              requestedAt: now,
              confirmedAt: now,
              ...(input.actor ? { actor: input.actor } : {}),
            },
          }
        : {}),
  };
  await stores.subscriptions.put(subscription);
  return subscriberDetail(stores, input.orgId, input.sub);
}
