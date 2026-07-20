/**
 * Signup + double opt-in (docs/ARCHITECTURE.md §4.2, §4.10).
 *
 * signup() creates the subscriber (global status active) and a PENDING
 * subscription, and returns a signed confirmation token. confirmOptIn() verifies
 * that token and flips the subscription to CONFIRMED.
 */
import { randomUUID } from "node:crypto";
import { schemas, type Subscriber, type Subscription } from "@addressium/core";
import type { Clock, ConfirmationTokenSigner, Stores } from "./ports.js";

export interface SignupResult {
  subscriber: Subscriber;
  subscription: Subscription;
  confirmationToken: string;
}

const CONFIRM_TTL_SECONDS = 60 * 60 * 24 * 3; // 3 days

export async function signup(
  stores: Stores,
  signer: ConfirmationTokenSigner,
  clock: Clock,
  raw: unknown,
): Promise<SignupResult> {
  const input = schemas.signupSchema.parse(raw);
  const email = input.email.trim().toLowerCase();

  const list = await stores.lists.get(input.orgId, input.listId);
  if (!list) throw new Error("unknown list");
  if (list.visibility === "closed") throw new Error("list is closed to signups");
  // Respect suppression (hard bounce / complaint / erasure tombstone).
  if (await stores.suppression.isSuppressed(input.orgId, email)) {
    throw new Error("address is suppressed");
  }

  // Reuse an existing subscriber (same person, keyed by Cognito sub) or create.
  let subscriber = await stores.subscribers.findByEmail(input.orgId, email);
  if (!subscriber) {
    subscriber = {
      orgId: input.orgId,
      sub: randomUUID(),
      email,
      attributes: input.attributes ?? {},
      source: input.sourceUrl,
      consent: input.sourceUrl
        ? { timestamp: clock.now().toISOString(), ip: "0.0.0.0", sourceUrl: input.sourceUrl }
        : undefined,
      status: "active",
      entitlement: "free",
    };
    await stores.subscribers.put(subscriber);
  }

  const subscription: Subscription = {
    orgId: input.orgId,
    subscriberId: subscriber.sub,
    listId: input.listId,
    status: "pending",
    updatedAt: clock.now().toISOString(),
  };
  await stores.subscriptions.put(subscription);

  const exp = Math.floor(clock.now().getTime() / 1000) + CONFIRM_TTL_SECONDS;
  const confirmationToken = signer.sign({
    orgId: input.orgId,
    sub: subscriber.sub,
    listId: input.listId,
    exp,
  });

  return { subscriber, subscription, confirmationToken };
}

export async function confirmOptIn(
  stores: Stores,
  signer: ConfirmationTokenSigner,
  clock: Clock,
  token: string,
): Promise<Subscription> {
  const { orgId, sub, listId } = signer.verify(token);
  const subscription = await stores.subscriptions.get(orgId, sub, listId);
  if (!subscription) throw new Error("no such subscription");
  if (subscription.status === "unsubscribed") throw new Error("subscription was unsubscribed");

  const confirmed: Subscription = {
    ...subscription,
    status: "confirmed",
    updatedAt: clock.now().toISOString(),
  };
  await stores.subscriptions.put(confirmed);
  return confirmed;
}
