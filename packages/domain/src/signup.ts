/**
 * Signup + double opt-in (docs/ARCHITECTURE.md §4.2, §4.10).
 *
 * signup() creates the subscriber (global status active) and a PENDING
 * subscription, and returns a signed confirmation token. signupMany() does the
 * same across several lists at once (the "All newsletters" page) with ONE
 * confirmation token covering them all. confirmOptIn()/confirmOptInAny() verify
 * the token and flip the subscription(s) to CONFIRMED.
 *
 * No account or login is required: signup is unauthenticated and creates an
 * addressium subscriber keyed by a local id, independent of any Cognito pool.
 */
import { randomUUID } from "node:crypto";
import { schemas, type Consent, type List, type Subscriber, type Subscription } from "@addressium/core";
import type { Clock, ConfirmationTokenSigner, Stores } from "./ports.js";

export interface SignupResult {
  subscriber: Subscriber;
  subscription: Subscription;
  confirmationToken: string;
}

export interface SignupManyResult {
  subscriber: Subscriber;
  subscriptions: Subscription[];
  lists: List[];
  confirmationToken: string;
}

const CONFIRM_TTL_SECONDS = 60 * 60 * 24 * 3; // 3 days

/**
 * Re-opt-in policy (#58): a suppressed address is normally rejected, but a prior
 * *user unsubscribe* or an automated *inactive* sunset (both org scope) is
 * self-clearable — a fresh double opt-in re-establishes consent. Bounce /
 * complaint / manual (erasure) stay blocked.
 */
async function clearOrRejectSuppression(stores: Stores, orgId: string, email: string): Promise<void> {
  const suppressions = await stores.suppression.entriesFor(orgId, email);
  if (suppressions.length === 0) return;
  const clearable = suppressions.every(
    (s) => (s.source === "unsubscribe" || s.source === "inactive") && s.scope === "org",
  );
  if (!clearable) throw new Error("address is suppressed");
  for (const s of suppressions) await stores.suppression.remove(s.orgId, s.email, s.scope);
}

/** Provenance of one signup request, as far as the caller could establish it. */
export interface RequestContext {
  /** The requester's IP. Omit rather than guess — see Consent.ip (#220). */
  sourceIp?: string;
  userAgent?: string;
  sourceUrl?: string;
}

function consentRecord(clock: Clock, ctx: RequestContext): Consent {
  // Built UNCONDITIONALLY. This used to be gated on sourceUrl being present, so
  // every server-side or embedded signup that did not pass one produced a fully
  // mailable subscriber with no provenance whatsoever (#220). A timestamp alone
  // is thin evidence, but it is evidence; nothing is none.
  return {
    timestamp: clock.now().toISOString(),
    ...(ctx.sourceIp ? { ip: ctx.sourceIp } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
    ...(ctx.sourceUrl ? { sourceUrl: ctx.sourceUrl } : {}),
  };
}

async function findOrCreateSubscriber(
  stores: Stores,
  clock: Clock,
  orgId: string,
  email: string,
  attributes: Record<string, string> | undefined,
  ctx: RequestContext,
): Promise<Subscriber> {
  const existing = await stores.subscribers.findByEmail(orgId, email);
  // A returning subscriber keeps their original subscriber-level consent — but
  // the per-subscription record below captures fresh provenance for the new
  // list, which is what a dispute about THAT list needs.
  if (existing) return existing;

  // The lookup above reads an eventually-consistent GSI with no uniqueness
  // constraint, so two concurrent signups for one address both reach here (#194).
  // The reservation is a single conditional write, which is the only thing that
  // actually decides the race: whoever loses gets the winner's id back.
  const proposed = randomUUID();
  const { sub } = await stores.subscribers.reserveEmail(orgId, email, proposed);
  if (sub !== proposed) {
    const winner = await stores.subscribers.getConsistent(orgId, sub);
    // The winner holds the address but has not finished writing their record —
    // a window of milliseconds. Failing the signup is the right answer: the
    // caller retries and finds them, whereas creating a second record here is
    // the duplicate this whole mechanism exists to prevent, and duplicates are
    // what let an erasure report success while a full profile survives.
    if (!winner) throw new Error("signup raced another signup for this address; retry");
    return winner;
  }

  const subscriber: Subscriber = {
    orgId,
    sub,
    email,
    attributes: attributes ?? {},
    source: ctx.sourceUrl,
    consent: consentRecord(clock, ctx),
    status: "active",
    entitlement: "free",
  };
  await stores.subscribers.put(subscriber);
  return subscriber;
}

async function pendingSubscription(
  stores: Stores,
  clock: Clock,
  orgId: string,
  sub: string,
  listId: string,
  ctx: RequestContext = {},
): Promise<Subscription> {
  const now = clock.now().toISOString();
  const existing = await stores.subscriptions.get(orgId, sub, listId);
  const subscription: Subscription = {
    orgId,
    subscriberId: sub,
    listId,
    status: "pending",
    updatedAt: now,
    // Re-requesting a list records the NEW request but keeps the original
    // confirmation evidence, if any — a re-signup does not un-prove the first
    // opt-in, and it must not silently inherit a confirmedAt it did not earn.
    consent: {
      ...(existing?.consent ?? {}),
      requestedAt: now,
      ...(ctx.sourceIp ? { requestIp: ctx.sourceIp } : {}),
      ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
      ...(ctx.sourceUrl ? { sourceUrl: ctx.sourceUrl } : {}),
      basis: "explicit",
    },
  };
  await stores.subscriptions.put(subscription);
  return subscription;
}

export async function signup(
  stores: Stores,
  signer: ConfirmationTokenSigner,
  clock: Clock,
  raw: unknown,
  ctx: RequestContext = {},
): Promise<SignupResult> {
  const input = schemas.signupSchema.parse(raw);
  const email = input.email.trim().toLowerCase();

  const list = await stores.lists.get(input.orgId, input.listId);
  if (!list) throw new Error("unknown list");
  if (list.visibility === "closed") throw new Error("list is closed to signups");

  await clearOrRejectSuppression(stores, input.orgId, email);
  const provenance: RequestContext = { ...ctx, sourceUrl: ctx.sourceUrl ?? input.sourceUrl };
  const subscriber = await findOrCreateSubscriber(stores, clock, input.orgId, email, input.attributes, provenance);
  const subscription = await pendingSubscription(stores, clock, input.orgId, subscriber.sub, input.listId, provenance);

  const exp = Math.floor(clock.now().getTime() / 1000) + CONFIRM_TTL_SECONDS;
  const confirmationToken = signer.sign({ orgId: input.orgId, sub: subscriber.sub, listId: input.listId, exp });

  return { subscriber, subscription, confirmationToken };
}

/**
 * Opt into several lists at once with a single double opt-in. Skips lists that
 * don't exist or are closed. One confirmation token carries all the list ids.
 */
export async function signupMany(
  stores: Stores,
  signer: ConfirmationTokenSigner,
  clock: Clock,
  raw: unknown,
  ctx: RequestContext = {},
): Promise<SignupManyResult> {
  const input = schemas.signupManySchema.parse(raw);
  const email = input.email.trim().toLowerCase();

  const wanted = [...new Set(input.listIds)];
  const lists: List[] = [];
  for (const listId of wanted) {
    const list = await stores.lists.get(input.orgId, listId);
    if (list && list.visibility !== "closed") lists.push(list);
  }
  if (lists.length === 0) throw new Error("no open lists to subscribe to");

  await clearOrRejectSuppression(stores, input.orgId, email);
  const provenance: RequestContext = { ...ctx, sourceUrl: ctx.sourceUrl ?? input.sourceUrl };
  const subscriber = await findOrCreateSubscriber(stores, clock, input.orgId, email, input.attributes, provenance);

  const subscriptions: Subscription[] = [];
  for (const list of lists) {
    subscriptions.push(
      await pendingSubscription(stores, clock, input.orgId, subscriber.sub, list.listId, provenance),
    );
  }

  const exp = Math.floor(clock.now().getTime() / 1000) + CONFIRM_TTL_SECONDS;
  const confirmationToken = signer.sign({ orgId: input.orgId, sub: subscriber.sub, listIds: lists.map((l) => l.listId), exp });

  return { subscriber, subscriptions, lists, confirmationToken };
}

export async function confirmOptIn(
  stores: Stores,
  signer: ConfirmationTokenSigner,
  clock: Clock,
  token: string,
  ctx: RequestContext = {},
): Promise<Subscription> {
  const { orgId, sub, listId } = signer.verify(token);
  if (!listId) throw new Error("token has no list");
  const subscription = await stores.subscriptions.get(orgId, sub, listId);
  if (!subscription) throw new Error("no such subscription");
  if (subscription.status === "unsubscribed") throw new Error("subscription was unsubscribed");

  const now = clock.now().toISOString();
  const confirmed: Subscription = {
    ...subscription,
    status: "confirmed",
    updatedAt: now,
    // The evidence a dispute actually needs. `updatedAt` cannot serve: an
    // unsubscribe, an erase or an import all rewrite it, destroying the only
    // trace of when confirmation happened (#220).
    consent: {
      requestedAt: subscription.consent?.requestedAt ?? now,
      ...subscription.consent,
      confirmedAt: now,
      ...(ctx.sourceIp ? { confirmIp: ctx.sourceIp } : {}),
      basis: "explicit",
    },
  };
  await stores.subscriptions.put(confirmed);
  return confirmed;
}

/**
 * Confirm every list carried by the token (single- or multi-list). Skips lists
 * with no pending subscription or that were already unsubscribed.
 */
export async function confirmOptInAny(
  stores: Stores,
  signer: ConfirmationTokenSigner,
  clock: Clock,
  token: string,
  ctx: RequestContext = {},
): Promise<Subscription[]> {
  const claims = signer.verify(token);
  const listIds = claims.listIds ?? (claims.listId ? [claims.listId] : []);
  const now = clock.now().toISOString();
  const confirmed: Subscription[] = [];
  for (const listId of listIds) {
    const subscription = await stores.subscriptions.get(claims.orgId, claims.sub, listId);
    if (!subscription || subscription.status === "unsubscribed") continue;
    const next: Subscription = {
      ...subscription,
      status: "confirmed",
      updatedAt: now,
      consent: {
        requestedAt: subscription.consent?.requestedAt ?? now,
        ...subscription.consent,
        confirmedAt: now,
        ...(ctx.sourceIp ? { confirmIp: ctx.sourceIp } : {}),
        basis: "explicit",
      },
    };
    await stores.subscriptions.put(next);
    confirmed.push(next);
  }
  return confirmed;
}
