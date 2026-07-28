/**
 * Entitlement sync (docs/ARCHITECTURE.md §4.3, §4.19).
 *
 * Applies an entitlement update from the billing system of record onto the
 * subscriber, so the value addressium mints into magic-link tokens stays fresh.
 * The caller (services/api) MUST verify the webhook signature first
 * (see webhooks.ts).
 */
import { schemas, type EntitlementSync, type Subscriber } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

/**
 * An entitlement update the billing system already superseded. A distinct error
 * so the API can answer 409 rather than 400 — the caller's webhook was not
 * malformed, it just lost a race, and a 400 would send someone to debug their
 * payload.
 */
export class StaleEntitlementError extends Error {
  constructor(
    public readonly received: string,
    public readonly current: string,
  ) {
    super(`entitlement version ${received} is not newer than ${current}`);
    this.name = "StaleEntitlementError";
  }
}

/**
 * Is `candidate` a later version than `current`?
 *
 * `version` is an opaque string from someone else's billing system, so the
 * ordering rule has to be stated rather than assumed. Numeric when BOTH parse as
 * finite numbers — otherwise `"10"` sorts before `"9"` and a counter-based feed
 * would reject every tenth update — and lexicographic otherwise, which is
 * correct for the ISO-8601 timestamps most providers send.
 *
 * A mixed-format feed (`"9"` then `"2026-07-28T…"`) falls to the lexicographic
 * branch and is the caller's problem; there is no ordering to recover there and
 * inventing one would be worse than refusing.
 *
 * Equality is NOT newer. A redelivery of the same version is a duplicate, and
 * applying it would restamp `entitlementAsof` to now — making stale data look
 * fresh to every token minted afterwards.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = Number(candidate);
  const b = Number(current);
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b;
  return candidate > current;
}

export async function applyEntitlementSync(
  stores: Stores,
  clock: Clock,
  raw: unknown,
): Promise<Subscriber> {
  const input = schemas.entitlementSyncSchema.parse(raw);
  const email = input.subscriberEmail.trim().toLowerCase();

  const subscriber = await stores.subscribers.findByEmail(input.orgId, email);
  if (!subscriber) throw new Error("unknown subscriber");

  // Refuse an update the billing system already superseded (#194). The `version`
  // was recorded and never compared, so two webhooks delivered out of order —
  // routine on any at-least-once transport — silently downgraded a paying
  // subscriber, and the only visible symptom was a paywall appearing for someone
  // who had just paid.
  //
  // `>=`, not `>`: a redelivery of the SAME version is a duplicate, and applying
  // it would restamp `entitlementAsof` to now, making stale data look fresh to
  // every token minted afterwards.
  const latest = await stores.entitlements.latest(input.orgId, subscriber.sub);
  if (latest && !isNewerVersion(input.version, latest.version)) {
    throw new StaleEntitlementError(input.version, latest.version);
  }

  const now = clock.now().toISOString();
  const updated: Subscriber = {
    ...subscriber,
    entitlement: input.entitlement,
    entitlementAsof: now,
  };
  // Conditional: a concurrent write between the read above and here would
  // otherwise be clobbered by this full-item snapshot.
  await stores.subscribers.put(updated, { ifRev: subscriber.rev });

  const record: EntitlementSync = {
    orgId: input.orgId,
    subscriberId: subscriber.sub,
    source: input.source,
    value: input.entitlement,
    version: input.version,
    at: now,
  };
  await stores.entitlements.put(record);

  return updated;
}
