/**
 * Subscriber preference centre (docs/ARCHITECTURE.md §4.10, #74).
 *
 * One place a subscriber manages every newsletter they are on, reached without a
 * password. The hard part is not the UI — it is that **anyone can type any email
 * address into a form**. A management surface that trusts a submitted address is
 * a mass-unsubscribe tool: enumerate addresses, POST, and remove strangers from
 * lists they wanted.
 *
 * So access is by emailed token, and the token is the proof:
 *
 * 1. `requestPreferenceLink` takes an address and mails a link **to that
 *    address**. It answers identically whether or not the subscriber exists —
 *    the response tells the caller nothing they did not already know.
 * 2. `preferenceCentre` reads the token, and lists what that ONE subscriber is
 *    on.
 * 3. `applyPreferences` writes changes for that one subscriber.
 *
 * The token is `scope: "manage"`, minted short-lived, and the signer refuses to
 * accept it anywhere a `confirm` token is expected and vice versa. That guard is
 * load-bearing: without it, the RFC 8058 unsubscribe token — which lives in
 * every message ever sent, with a five-year TTL — would open a management
 * session over every list its holder is subscribed to.
 *
 * This works identically in both magic-link modes (#74's "router vs access
 * point"). Nothing here touches Cognito: a linked pool changes how a reader
 * proves ownership *on the operator's own site*, not how they manage
 * subscriptions here.
 */
import type { List, Subscription, SubscriptionStatus } from "@addressium/core";
import type { Clock, ConfirmationTokenSigner, Stores } from "./ports.js";

/**
 * How long a management link is good for.
 *
 * Deliberately short, and much shorter than the unsubscribe token's five years.
 * The trade is not the same: an unsubscribe link must work when someone opens an
 * archived email years later, because a dead unsubscribe link is a compliance
 * failure. A management link is requested on purpose, seconds before it is used,
 * and grants far more — it can RE-subscribe, so a leaked one is a way to put
 * mail back into someone's inbox.
 */
export const PREFERENCE_TOKEN_TTL_SECONDS = 60 * 60;

/** One row of the preference centre: a list, and whether this person is on it. */
export interface PreferenceRow {
  listId: string;
  name: string;
  description?: string;
  /** Absent when they have never subscribed to this list. */
  status?: SubscriptionStatus;
  subscribed: boolean;
}

export interface PreferenceView {
  orgId: string;
  /** For display only — the address the token was minted for. */
  email: string;
  rows: PreferenceRow[];
}

/**
 * Mint a management token for a subscriber, or return `undefined` when the
 * address is not on file.
 *
 * The CALLER decides what to do with `undefined`, and the only correct answer is
 * "the same thing you do on success". Returning a distinguishable response —
 * a 404, a different message, even a measurably faster one — turns this into an
 * address-enumeration oracle against the subscriber base.
 */
export async function requestPreferenceLink(
  stores: Stores,
  signer: ConfirmationTokenSigner,
  clock: Clock,
  input: { orgId: string; email: string },
): Promise<{ token: string; subscriberId: string } | undefined> {
  const subscriber = await stores.subscribers.findByEmail(input.orgId, input.email.trim().toLowerCase());
  if (!subscriber) return undefined;
  const token = signer.sign({
    orgId: input.orgId,
    sub: subscriber.sub,
    scope: "manage",
    exp: Math.floor(clock.now().getTime() / 1000) + PREFERENCE_TOKEN_TTL_SECONDS,
  });
  return { token, subscriberId: subscriber.sub };
}

/**
 * Every list this org publishes, marked with whether this subscriber is on it.
 *
 * Closed lists they are NOT on are omitted — a closed list is one the operator
 * has stopped offering, and showing it as an option to join is an invitation to
 * subscribe to something that will never send. A closed list they ARE on stays
 * visible, because they must always be able to leave.
 */
export async function preferenceCentre(
  stores: Stores,
  orgId: string,
  subscriberId: string,
): Promise<PreferenceView> {
  const subscriber = await stores.subscribers.get(orgId, subscriberId);
  if (!subscriber) throw new Error("unknown subscriber");
  const [lists, subs] = await Promise.all([
    stores.lists.list(orgId),
    stores.subscriptions.listBySubscriber(orgId, subscriberId),
  ]);
  const bySub = new Map(subs.map((s) => [s.listId, s]));
  const rows: PreferenceRow[] = [];
  for (const list of lists) {
    const sub = bySub.get(list.listId);
    if (!sub && list.visibility === "closed") continue;
    rows.push({
      listId: list.listId,
      name: list.name,
      ...(list.description ? { description: list.description } : {}),
      ...(sub ? { status: sub.status } : {}),
      subscribed: sub?.status === "confirmed",
    });
  }
  return { orgId, email: subscriber.email, rows };
}

export interface PreferenceChange {
  listId: string;
  subscribed: boolean;
}

export interface PreferenceUpdateResult {
  unsubscribed: string[];
  resubscribed: string[];
  /** Requested lists that do not exist, or that are closed to new subscribers. */
  rejected: string[];
}

/**
 * Apply preference changes for ONE subscriber.
 *
 * Two asymmetries are deliberate:
 *
 * - **Unsubscribing always works.** From any status, on any list, including a
 *   closed one. Nothing may stand between a person and leaving.
 * - **Re-subscribing does not resurrect a bounced or complained subscription.**
 *   Those are statements about the address and about us, not preferences, and
 *   letting a form clear them would undo suppression through the front door.
 *   It also cannot join a `closed` list.
 *
 * Re-subscribing from `unsubscribed` goes straight to `confirmed` rather than
 * back through double opt-in: the person is holding a token we mailed to that
 * address, which is the same proof double opt-in exists to collect. The consent
 * record is stamped so the basis of that decision is auditable.
 */
export async function applyPreferences(
  stores: Stores,
  clock: Clock,
  orgId: string,
  subscriberId: string,
  changes: PreferenceChange[],
): Promise<PreferenceUpdateResult> {
  const result: PreferenceUpdateResult = { unsubscribed: [], resubscribed: [], rejected: [] };
  const now = clock.now().toISOString();

  for (const change of changes) {
    const list = await stores.lists.get(orgId, change.listId);
    const existing = await stores.subscriptions.get(orgId, subscriberId, change.listId);

    if (!change.subscribed) {
      // Leaving. No list lookup gates this: a list that was deleted out from
      // under a subscription must not trap someone in it.
      if (!existing || existing.status === "unsubscribed") continue;
      await stores.subscriptions.put({ ...existing, status: "unsubscribed", updatedAt: now });
      result.unsubscribed.push(change.listId);
      continue;
    }

    if (!list || list.visibility === "closed") {
      result.rejected.push(change.listId);
      continue;
    }
    // Bounced and complained are not preferences. Re-subscribing through this
    // form would clear a suppression the address itself earned.
    if (existing && (existing.status === "bounced" || existing.status === "complained")) {
      result.rejected.push(change.listId);
      continue;
    }
    if (existing?.status === "confirmed") continue;

    const subscription: Subscription = {
      orgId,
      subscriberId,
      listId: change.listId,
      status: "confirmed",
      updatedAt: now,
      consent: {
        ...(existing?.consent ?? {}),
        requestedAt: existing?.consent?.requestedAt ?? now,
        confirmedAt: now,
        // `explicit`: they clicked a link mailed to the address, which is the
        // same evidence double opt-in collects. Recording it as anything weaker
        // would understate the proof we actually hold.
        basis: "explicit",
      },
    };
    await stores.subscriptions.put(subscription);
    result.resubscribed.push(change.listId);
  }
  return result;
}

/** The "manage your subscriptions" email (#74). Transactional — see EmailClass. */
export function buildPreferenceLinkEmail(
  list: List | undefined,
  toEmail: string,
  manageUrl: string,
  orgName: string,
): {
  emailClass: "transactional";
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  listUnsubscribe: string;
} {
  // Any list of the org's carries a usable from-address; the request is not
  // about one newsletter, so the first is as good as any.
  const from = list?.fromAddress ?? `no-reply@${orgName}`;
  const html = [
    `<p>Use this link to manage your ${escapeText(orgName)} subscriptions:</p>`,
    `<p><a href="${escapeText(manageUrl)}">Manage my subscriptions</a></p>`,
    `<p style="font-size:12px;color:#777">The link expires in an hour. If you did not ask for it, ignore this message — nothing has changed.</p>`,
  ].join("\n");
  return {
    emailClass: "transactional",
    from,
    to: toEmail,
    subject: `Manage your ${orgName} subscriptions`,
    html,
    text: `Manage your ${orgName} subscriptions: ${manageUrl}\n\nThe link expires in an hour. If you did not ask for it, ignore this message.`,
    // mailto-only: a management link is not a campaign, so it advertises no
    // one-click POST (the SES adapter omits that header for mailto).
    listUnsubscribe: `<mailto:${from}>`,
  };
}

const escapeText = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
