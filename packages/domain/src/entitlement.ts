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

export async function applyEntitlementSync(
  stores: Stores,
  clock: Clock,
  raw: unknown,
): Promise<Subscriber> {
  const input = schemas.entitlementSyncSchema.parse(raw);
  const email = input.subscriberEmail.trim().toLowerCase();

  const subscriber = await stores.subscribers.findByEmail(input.orgId, email);
  if (!subscriber) throw new Error("unknown subscriber");

  const now = clock.now().toISOString();
  const updated: Subscriber = {
    ...subscriber,
    entitlement: input.entitlement,
    entitlementAsof: now,
  };
  await stores.subscribers.put(updated);

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
