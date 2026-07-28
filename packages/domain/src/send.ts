/**
 * Campaign send (docs/ARCHITECTURE.md §4.4).
 *
 * Resolves confirmed recipients, drops suppressed addresses, archives the
 * generic body + link-map once, then per recipient mints a magic-link token (if
 * the org has the feature on), renders, and hands the message to the EmailSender
 * (SES in prod). Records a "sent" event per recipient.
 */
import type { EmailArchive, EngagementEvent, List, OrgEnvironment, Subscriber } from "@addressium/core";
import type {
  Clock,
  EmailSender,
  MagicLinkSigner,
  SendDescriptor,
  SendQueue,
  SendThrottle,
  Stores,
} from "./ports.js";
import { buildLinkMap, renderForRecipient, type EmailTemplate } from "./render.js";
import { scheduleActive } from "./schedule-state.js";

/** Alias kept for readability; a campaign send takes a SendDescriptor. */
export type SendCampaignInput = SendDescriptor;

/**
 * Mints the RFC 8058 one-click unsubscribe URL for one recipient.
 *
 * Injected rather than built inline because the URL needs a deployment-specific
 * base AND a signed token — `unsubscribeHandler` verifies a signed token, while
 * the header used to carry bare `?sub=&list=` params at a `.example` host, so
 * one-click was doubly broken (#178).
 */
export interface UnsubscribeLinkBuilder {
  build(input: { orgId: string; subscriberId: string; listId: string }): Promise<string>;
}

export interface SendOptions {
  /** Paces per-recipient sends to the SES rate (§4.4). */
  throttle?: SendThrottle;
  /** When absent, the header degrades to `mailto:` (see listUnsubscribeHeader). */
  unsubscribeLink?: UnsubscribeLinkBuilder;
}

export interface SendResult {
  sent: number;
  suppressed: number;
  /** Recipients dropped by a dev org's send allowlist (§4.11). */
  devBlocked?: number;
  /** Recipients already claimed by an earlier delivery of this campaign. */
  alreadySent?: number;
  /**
   * Recipients sent WITHOUT a magic-link token although the org has the feature
   * on, because they have no `externalId` yet (see mintToken). Zero in the
   * normal case; a non-zero count on a magic-links org is the visible symptom of
   * subscribers that predate the toggle and still need the account backfill.
   */
  untokenized?: number;
  /** True if this campaign (or slice) had nothing new to dispatch. */
  skipped?: boolean;
  /** True if a deliverability halt stopped this send (§4.13). */
  halted?: boolean;
}

/** How often the halt flag is re-read mid-loop (in recipients). */
const HALT_CHECK_EVERY = 100;

/**
 * Per-recipient idempotency key.
 *
 * The claim used to be taken ONCE for the whole campaign/slice *before* the
 * loop and never released — so a crash at recipient 500 of 2000 left the claim
 * held, and the SQS redelivery returned `skipped` and ACKed the message. The
 * remaining 1500 were never sent and nothing reported it (#163). Claiming per
 * recipient instead makes a send resumable: a retry re-sends nobody and
 * delivers exactly the remainder. It also removes the duplicate-whole-list
 * window at the fan-out chunk boundary (#172), since slice and non-slice paths
 * now share one key space.
 */
function recipientClaimKey(campaignId: string, subscriberId: string): string {
  return `${campaignId}#${subscriberId}`;
}

/** Split a confirmed-recipient count into offset/limit windows of `chunkSize`. */
export function planFanOut(total: number, chunkSize: number): Array<{ offset: number; limit: number }> {
  if (chunkSize <= 0) throw new Error("chunkSize must be > 0");
  const slices: Array<{ offset: number; limit: number }> = [];
  for (let offset = 0; offset < total; offset += chunkSize) {
    slices.push({ offset, limit: Math.min(chunkSize, total - offset) });
  }
  return slices;
}

/**
 * Fan a large campaign out across the queue: count confirmed recipients and, if
 * they exceed `chunkSize`, enqueue one sliced descriptor per window so the
 * sender processes them in parallel. Returns the slices enqueued (empty when
 * the list fits in one message and no fan-out was needed).
 */
export async function fanOutCampaign(
  stores: Stores,
  queue: SendQueue,
  descriptor: SendDescriptor,
  chunkSize: number,
): Promise<Array<{ offset: number; limit: number }>> {
  const confirmed = await stores.subscriptions.listConfirmed(descriptor.orgId, descriptor.listId);
  if (confirmed.length <= chunkSize) return [];
  const slices = planFanOut(confirmed.length, chunkSize);
  for (const slice of slices) {
    await queue.enqueue({ ...descriptor, slice });
  }
  return slices;
}

/**
 * Dev-org send guard (#77 fast-follow). A `dev` org may only send to addresses
 * on its explicit allowlist, so a test campaign can never reach a real
 * subscriber. Prod orgs (and legacy records with no `environment`) are never
 * gated. Fail-closed: a dev org with no allowlist sends to no one. Entries are
 * exact emails (case-insensitive) or `@domain` suffixes.
 */
export function recipientAllowedForDev(
  org: { environment?: OrgEnvironment; devAllowlist?: string[] } | undefined,
  email: string,
): boolean {
  if (!org || (org.environment ?? "prod") !== "dev") return true;
  const addr = email.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  const domain = at >= 0 ? addr.slice(at) : ""; // includes the leading "@"
  for (const raw of org.devAllowlist ?? []) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("@")) {
      if (domain && domain === entry) return true;
    } else if (addr === entry) {
      return true;
    }
  }
  return false;
}

/**
 * RFC 8058 / RFC 2369 List-Unsubscribe value (docs/ARCHITECTURE.md §6).
 *
 * With a link builder this is a signed https URL the API can actually honor.
 * WITHOUT one it degrades to `mailto:` rather than advertising an https
 * endpoint that 404s — SesEmailSender only stamps `List-Unsubscribe-Post` for
 * an https URI, so the mailto form correctly stops claiming one-click support.
 * The old value pointed at `unsub.<org>.example`, a reserved domain that cannot
 * resolve, and carried bare `?sub=&list=` params that `unsubscribeHandler`
 * rejects anyway — so every one-click attempt failed (#178).
 */
async function listUnsubscribeHeader(
  list: List,
  sub: string,
  builder?: UnsubscribeLinkBuilder,
): Promise<string> {
  if (builder) {
    const url = await builder.build({ orgId: list.orgId, subscriberId: sub, listId: list.listId });
    return `<${url}>`;
  }
  return `<mailto:${list.fromAddress}?subject=unsubscribe>`;
}

export interface SendOneInput {
  orgId: string;
  /** Distinct id for this per-recipient send (idempotency + event grouping). */
  campaignId: string;
  subscriberId: string;
  listId: string;
  subject: string;
  template: EmailTemplate;
  /** Optional pacing — acquired only for an actual send (skips don't burn tokens). */
  throttle?: SendThrottle;
  /** See SendOptions.unsubscribeLink — same contract for per-recipient sends. */
  unsubscribeLink?: UnsubscribeLinkBuilder;
}

export interface SendOneResult {
  sent: boolean;
  reason?: "unknown-subscriber" | "suppressed" | "already-sent" | "dev-allowlist";
}

/**
 * Mint this recipient's magic-link token, or `undefined` when there is nothing
 * to mint:
 *  - no signer — the org has magic links off, so no token is ever minted; or
 *  - no `externalId` — the subscriber has no account in the org's linked pool
 *    yet, and a token without the pool `sub` is one the paywall cannot resolve.
 *
 * Neither case fails the send: the message still goes out, with plain editorial
 * links that keep their link-ids (see renderForRecipient).
 */
async function mintToken(
  magic: MagicLinkSigner | undefined,
  subscriber: Subscriber,
): Promise<string | undefined> {
  if (!magic || !subscriber.externalId) return undefined;
  return magic.mint({
    orgId: subscriber.orgId,
    sub: subscriber.sub,
    externalId: subscriber.externalId,
    entitlement: subscriber.entitlement,
    entitlementAsof: subscriber.entitlementAsof,
  });
}

/**
 * Send one message to one subscriber (drip step / transactional, §4.6). Applies
 * the same suppression gate, magic-link minting, render and sent-event append as
 * a campaign send, with per-(campaign,subscriber) idempotency.
 *
 * `magic` is `undefined` for an org with magic links off — the send is otherwise
 * identical, so it stays `sent: true` and the caller's counters (and the win-back
 * sequence, #181) are unaffected by the feature being off.
 */
export async function sendToSubscriber(
  stores: Stores,
  sender: EmailSender,
  magic: MagicLinkSigner | undefined,
  clock: Clock,
  input: SendOneInput,
): Promise<SendOneResult> {
  const list = await stores.lists.get(input.orgId, input.listId);
  if (!list) throw new Error("unknown list");
  if (!(await stores.sendClaims.claim(input.orgId, `${input.campaignId}#${input.subscriberId}`))) {
    return { sent: false, reason: "already-sent" };
  }
  const claimKey = `${input.campaignId}#${input.subscriberId}`;
  // Any exit that does NOT dispatch must give the claim back, or a transient
  // failure permanently prevents this subscriber from ever receiving the step —
  // which, in the re-engagement sweep, then sunsets them unread (#163, #181).
  const release = () => stores.sendClaims.release(input.orgId, claimKey);

  const subscriber = await stores.subscribers.get(input.orgId, input.subscriberId);
  if (!subscriber) {
    await release();
    return { sent: false, reason: "unknown-subscriber" };
  }
  if (await stores.suppression.isSuppressed(input.orgId, subscriber.email)) {
    await release();
    return { sent: false, reason: "suppressed" };
  }
  // Dev allowlist: a test org can only reach addresses on its list (§4.11).
  const org = await stores.organizations.get(input.orgId);
  if (!recipientAllowedForDev(org, subscriber.email)) {
    await release();
    return { sent: false, reason: "dev-allowlist" };
  }
  if (input.throttle) await input.throttle.acquire();
  try {
    const token = await mintToken(magic, subscriber);
    await sender.send({
      from: list.fromAddress,
      to: subscriber.email,
      subject: input.subject,
      html: renderForRecipient(input.template, subscriber.attributes, token),
      listUnsubscribe: await listUnsubscribeHeader(list, subscriber.sub, input.unsubscribeLink),
      tags: { orgId: input.orgId, campaignId: input.campaignId, subscriberId: subscriber.sub },
    });
  } catch (e) {
    await release();
    throw e;
  }
  await stores.events.append({
    orgId: input.orgId,
    subscriberId: subscriber.sub,
    campaignId: input.campaignId,
    type: "sent",
    at: clock.now().toISOString(),
  });
  return { sent: true };
}

/**
 * A template with no content renders to an empty body. Sending that to a whole
 * list is worse than failing — the send is claimed on the campaign id, so the
 * edition can never be corrected and re-sent (#174). Fail loudly instead.
 */
export function templateIsEmpty(t: EmailTemplate): boolean {
  // `EmailTemplate` uses optional, mutually-exclusive fields (see render.ts), so
  // check for presence the same way buildLinkMap does rather than via `in`.
  if (t.html != null) return t.html.trim() === "";
  return (t.blocks ?? []).length === 0;
}

export async function sendCampaign(
  stores: Stores,
  sender: EmailSender,
  magic: MagicLinkSigner | undefined,
  clock: Clock,
  input: SendCampaignInput,
  opts: SendOptions = {},
): Promise<SendResult> {
  const list = await stores.lists.get(input.orgId, input.listId);
  if (!list) throw new Error("unknown list");
  if (templateIsEmpty(input.template)) {
    throw new Error(`refusing to send empty template for campaign ${input.campaignId}`);
  }

  // Lifecycle gate: a paused or archived one-off never sends (§4.6). Checked
  // before the idempotency claim so resuming can still send later. Recurring
  // editions carry an edition-stamped id with no schedule record here — they're
  // gated upstream in the launch handler — so this only bites one-offs.
  const schedule = await stores.schedules.get(input.orgId, input.campaignId);
  if (!scheduleActive(schedule)) {
    return { sent: 0, suppressed: 0, skipped: true };
  }

  // Archive the generic body (§4.8) — powers the click overlay. Deterministic
  // put keyed by campaignId, so repeating it across slices is harmless.
  const linkMap = buildLinkMap(input.template);
  const archive: EmailArchive = {
    orgId: input.orgId,
    campaignId: input.campaignId,
    s3Key: `archive/${input.orgId}/${input.campaignId}.html`,
    linkMap,
  };
  await stores.archive.put(archive);

  // Dev orgs gate every recipient against their allowlist (§4.11). One org read
  // per campaign/slice, not per recipient.
  const org = await stores.organizations.get(input.orgId);

  const all = await stores.subscriptions.listConfirmed(input.orgId, input.listId);
  // A slice sends only its window of the confirmed set; no slice → the whole list.
  const confirmed = input.slice
    ? all.slice(input.slice.offset, input.slice.offset + input.slice.limit)
    : all;
  let sent = 0;
  let suppressed = 0;
  let devBlocked = 0;
  let alreadySent = 0;
  let untokenized = 0;

  // Deliverability halt (§4.13, #165). checkDeliverability flips the campaign to
  // "halted" on a bounce/complaint breach, but NOTHING in the send path read it,
  // so a halted campaign ran to completion. Re-checked periodically inside the
  // loop, because a breach detected mid-send must stop the remainder — not just
  // the next campaign.
  const isHalted = async () =>
    (await stores.campaigns.get(input.orgId, input.campaignId))?.status === "halted";
  if (await isHalted()) {
    return { sent: 0, suppressed: 0, skipped: true, halted: true };
  }
  let halted = false;
  let seen = 0;

  for (const sub of confirmed) {
    if (seen > 0 && seen % HALT_CHECK_EVERY === 0 && (await isHalted())) {
      halted = true;
      break;
    }
    seen++;
    const subscriber = await stores.subscribers.get(input.orgId, sub.subscriberId);
    if (!subscriber) continue;

    // Suppression enforced before every send (§4.4, §4.13).
    if (await stores.suppression.isSuppressed(input.orgId, subscriber.email)) {
      suppressed++;
      continue;
    }

    // Dev allowlist: a test org can't reach anyone off its list (§4.11).
    if (!recipientAllowedForDev(org, subscriber.email)) {
      devBlocked++;
      continue;
    }

    // Idempotency, per recipient (#163). Claimed immediately before the send so
    // a redelivery skips exactly those already dispatched and delivers the rest.
    if (!(await stores.sendClaims.claim(input.orgId, recipientClaimKey(input.campaignId, subscriber.sub)))) {
      alreadySent++;
      continue;
    }

    // Throttle only actual sends so skipped/suppressed rows don't burn tokens.
    if (opts.throttle) await opts.throttle.acquire();

    try {
      const token = await mintToken(magic, subscriber);
      if (magic && token === undefined) untokenized++;
      const html = renderForRecipient(input.template, subscriber.attributes, token);

      await sender.send({
        from: list.fromAddress,
        to: subscriber.email,
        subject: input.subject,
        html,
        listUnsubscribe: await listUnsubscribeHeader(list, subscriber.sub, opts.unsubscribeLink),
        tags: { orgId: input.orgId, campaignId: input.campaignId, subscriberId: subscriber.sub },
      });
    } catch (e) {
      // The claim guards a dispatch that did not happen — give it back so the
      // retry re-attempts THIS recipient instead of skipping them forever.
      await stores.sendClaims.release(input.orgId, recipientClaimKey(input.campaignId, subscriber.sub));
      throw e;
    }

    const evt: EngagementEvent = {
      orgId: input.orgId,
      subscriberId: subscriber.sub,
      campaignId: input.campaignId,
      type: "sent",
      at: clock.now().toISOString(),
    };
    await stores.events.append(evt);
    sent++;
  }

  // `skipped` now means "nothing new to dispatch" — true for a full redelivery
  // (every recipient already claimed), false when a retry delivered a remainder.
  return {
    sent,
    suppressed,
    devBlocked,
    alreadySent,
    untokenized,
    skipped: sent === 0 && alreadySent > 0,
    ...(halted ? { halted: true } : {}),
  };
}
