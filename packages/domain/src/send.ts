/**
 * Campaign send (docs/ARCHITECTURE.md §4.4).
 *
 * Resolves confirmed recipients, drops suppressed addresses, archives the
 * generic body + link-map once, then per recipient mints a magic-link token (if
 * the org has the feature on), renders, and hands the message to the EmailSender
 * (SES in prod). Records a "sent" event per recipient.
 */
import type {
  EmailArchive,
  EmailClass,
  EngagementEvent,
  List,
  OrgEnvironment,
  Subscriber,
  SuppressionSource,
} from "@addressium/core";
import { RESERVED_MERGE_TAGS } from "@addressium/core";
import type {
  Clock,
  EmailSender,
  MagicLinkSigner,
  RecipientSlice,
  SendDescriptor,
  SegmentResolver,
  SendQueue,
  SendThrottle,
  Stores,
} from "./ports.js";
import { RecipientRejectedError } from "./ports.js";
import { mergeTagFallbacks } from "./merge-tags.js";
import { applySeriesAdFills, buildLinkMap, plainTextFrom, renderForRecipient, type EmailTemplate } from "./render.js";
import { completeScheduleRange, scheduleActive } from "./schedule-state.js";

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
  /**
   * Resolves `descriptor.segmentId` to its members (#203). Required whenever a
   * descriptor carries a segment — see `segmentRecipients`.
   */
  segments?: SegmentResolver;
  /** Writes the generic rendered body used by the authenticated click-map view. */
  archiveBody?: { put(key: string, html: string): Promise<void> };
}

/**
 * Narrow a confirmed-subscription set to a segment's members (#203).
 *
 * **Fails closed.** A descriptor that names a segment with no resolver
 * configured, or names a segment that no longer exists, throws — it does not
 * fall back to the whole list. The two failure directions are not symmetric:
 * sending to nobody is a visible mistake someone fixes in a minute, and sending
 * a segment-targeted campaign to every confirmed subscriber on the list is
 * unrecallable. The old code had no segment support at all, so a campaign saved
 * with a segment audience simply mailed the whole list.
 */
async function segmentRecipients<T extends { subscriberId: string }>(
  stores: Stores,
  rows: T[],
  orgId: string,
  segmentId: string | undefined,
  resolver: SegmentResolver | undefined,
): Promise<T[]> {
  if (!segmentId) return rows;
  if (!resolver) {
    throw new Error(
      `campaign targets segment ${segmentId} but no segment resolver is configured — refusing to send to the whole list`,
    );
  }
  const segment = await stores.segments.get(orgId, segmentId);
  if (!segment) throw new Error(`unknown segment ${segmentId}`);

  const members = new Set<string>();
  for await (const id of resolver.resolve(orgId, segment.predicate as never)) members.add(id);
  // Intersected with the confirmed set rather than used directly: segment
  // membership is not consent. A subscriber who unsubscribed from this list must
  // not be reachable by being named in a segment.
  return rows.filter((r) => members.has(r.subscriberId));
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
  /**
   * Recipients SES refused individually (#293) — an address it will not send
   * to, recorded as a `reject` event and skipped so the rest of the slice still
   * goes out. Absent when zero.
   *
   * A non-zero count on a production send is worth looking at: these addresses
   * are permanently unsendable, so they are list hygiene rather than a
   * transient fault. A LARGE count is a different signal entirely — the send
   * aborts at MAX_CONSECUTIVE_REJECTS, because that is an account-level fault
   * wearing a per-recipient disguise.
   */
  rejected?: number;
  /** True if this campaign (or slice) had nothing new to dispatch. */
  skipped?: boolean;
  /** True if a deliverability halt stopped this send (§4.13). */
  halted?: boolean;
}

/**
 * The idempotency key for "this campaign has already been sent to this
 * subscriber" (#196).
 *
 * `#` is the separator precisely because `idSchema` forbids it in a campaignId,
 * which makes the join unambiguous: a campaign literally named `promo#x` used to
 * produce the same key as campaign `promo` and a subscriber whose id started
 * `x`, and the loser was silently skipped as "already sent" — a subscriber who
 * never receives the campaign, with nothing in any log to say why.
 *
 * subscriberId is a UUID, so it cannot contain `#` either; the campaign
 * constraint alone is enough, but both halves are worth stating because a change
 * to either one reopens this.
 *
 * It is PER RECIPIENT, and that is load-bearing. The claim used to be taken once
 * for the whole campaign/slice before the loop and never released — so a crash
 * at recipient 500 of 2000 left it held, the SQS redelivery returned `skipped`
 * and ACKed the message, and the remaining 1500 were never sent with nothing
 * reporting it (#163). Per recipient makes a send resumable: a retry re-sends
 * nobody and delivers exactly the remainder. It also closes the
 * duplicate-whole-list window at the fan-out chunk boundary (#172), because the
 * slice and non-slice paths share one key space.
 *
 * `sendOne` and `sendCampaign` had SEPARATE, identical copies of this
 * expression. They agreed, but only by inspection — and a claim taken under one
 * key and released under another is a subscriber who can never receive the
 * campaign again.
 */
export function sendClaimKey(campaignId: string, subscriberId: string): string {
  return `${campaignId}#${subscriberId}`;
}

/** How often the halt flag is re-read mid-loop (in recipients). */
const HALT_CHECK_EVERY = 100;
/**
 * Consecutive per-recipient rejections that abort the slice (#293).
 *
 * The backstop for an account-level fault the SES adapter misclassified as
 * per-recipient — an unverified FROM identity raises the same `MessageRejected`
 * for every recipient. Without this, such a fault would write one reject per
 * recipient and report a COMPLETED send that mailed nobody, which is a worse
 * failure than aborting because it looks like success.
 *
 * Ten, and consecutive: high enough that a real list's scattered bad addresses
 * never trip it, low enough that a systemic fault stops in ten calls rather
 * than twenty thousand.
 */
const MAX_CONSECUTIVE_REJECTS = 10;

/**
 * Split an ORDERED list of recipient ids into key-range windows of `chunkSize`
 * (#171). Takes the ids themselves, not a count, because the boundaries have to
 * be ids — a count can only produce offsets, and offsets are what break.
 *
 * The last window is deliberately open-ended: someone who confirms after the
 * plan is made still falls inside it and gets the campaign, rather than landing
 * past the final boundary and being silently dropped.
 */
export function planFanOut(orderedIds: string[], chunkSize: number): RecipientSlice[] {
  if (chunkSize <= 0) throw new Error("chunkSize must be > 0");
  const slices: RecipientSlice[] = [];
  for (let i = 0; i < orderedIds.length; i += chunkSize) {
    const isLast = i + chunkSize >= orderedIds.length;
    const after = i === 0 ? undefined : orderedIds[i - 1];
    const until = isLast ? undefined : orderedIds[i + chunkSize - 1];
    slices.push({ ...(after ? { after } : {}), ...(until ? { until } : {}) });
  }
  return slices;
}

/** The recipients of one key-range window. Ranges are disjoint and cover everything. */
export function recipientsInSlice<T extends { subscriberId: string }>(
  ordered: T[],
  slice: RecipientSlice | undefined,
): T[] {
  if (!slice) return ordered;
  return ordered.filter(
    (s) =>
      (slice.after === undefined || s.subscriberId > slice.after) &&
      (slice.until === undefined || s.subscriberId <= slice.until),
  );
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
  segments?: SegmentResolver,
): Promise<RecipientSlice[]> {
  // Narrowed BEFORE the windows are computed (#203). Slicing the whole list and
  // filtering per slice would produce mostly-empty messages and boundaries that
  // mean nothing — and for a small cohort on a large list, thousands of them.
  const confirmed = await segmentRecipients(
    stores,
    await stores.subscriptions.listConfirmed(descriptor.orgId, descriptor.listId),
    descriptor.orgId,
    descriptor.segmentId,
    segments,
  );
  if (confirmed.length <= chunkSize) return [];
  // Ordered by subscriber id — the order the store returns and the order the
  // ranges are expressed in. Sorting here rather than trusting the caller keeps
  // the boundaries meaningful even if a store ever returns unordered rows.
  const ordered = [...confirmed].sort((a, b) => a.subscriberId.localeCompare(b.subscriberId));
  const slices = planFanOut(ordered.map((c) => c.subscriberId), chunkSize);
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
  // NOTE (#201): a MISSING org returns `true` here, which reads as a fail-OPEN
  // and is called out as contradicting the documented intent. It is not fixed in
  // place because it cannot be: "no org record" is a normal condition across the
  // send path and 28 tests, so denying here changes the contract to "every send
  // requires an org record" — defensible, arguably right, and far larger than a
  // one-line guard. Tracked separately rather than smuggled in.
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
/**
 * The merge values one recipient's body renders from (#204).
 *
 * Subscriber attributes PLUS the values only the send path knows: the
 * unsubscribe URL and the list's display name. Without this,
 * `<a href="{{unsubscribe_url}}">Unsubscribe</a>` — the obvious way to write the
 * one link a recipient is legally entitled to — rendered `href=""`, because
 * merge values came only from `subscriber.attributes` and no subscriber has an
 * `unsubscribe_url` attribute. The link was still there and still blue, so it
 * looked right in every preview.
 *
 * Reserved names win over a subscriber attribute of the same name. An imported
 * CSV column called `unsubscribe_url` must not be able to replace the real one.
 *
 * PRECEDENCE, lowest to highest: configured fallbacks, per-campaign values
 * (such as a feed's lead item), the subscriber's own non-empty attributes, then
 * the reserved values. `fallbacks` comes from `mergeTagFallbacks`, read once per
 * send by the caller rather than per recipient.
 *
 * "WHEN EMPTY" MEANS ABSENT **OR** BLANK, and that is deliberate — the console
 * labels the field "fallback when empty", and the ordinary way an attribute
 * comes up empty is a CSV import with a blank cell, which yields `""` and not a
 * missing key. Filtering only `undefined` would leave exactly the common case
 * rendering blank while the operator saw a fallback configured. Do not
 * "simplify" the blank filter below back to a plain spread.
 */
async function mergeValues(
  list: List,
  subscriber: Subscriber,
  builder: UnsubscribeLinkBuilder | undefined,
  fallbacks: Record<string, string>,
  campaignAttributes: Record<string, string> = {},
): Promise<Record<string, string>> {
  const unsubscribeUrl = builder
    ? await builder.build({ orgId: list.orgId, subscriberId: subscriber.sub, listId: list.listId })
    : `mailto:${list.fromAddress}?subject=unsubscribe`;
  // Resolved per reserved NAME rather than written out as object keys, so
  // `RESERVED_MERGE_TAGS` is the one list and the merge-tag registry the console
  // shows cannot drift from what actually resolves here. A name added to the
  // constant with no case below throws — loudly, in a domain test — instead of
  // being displayed to an operator as a tag that renders empty.
  const reserved: Record<string, string> = {};
  for (const tag of RESERVED_MERGE_TAGS) {
    switch (tag.name) {
      case "unsubscribe_url":
        reserved[tag.name] = unsubscribeUrl;
        break;
      case "list_name":
        reserved[tag.name] = list.name;
        break;
      case "compliance_footer":
        reserved[tag.name] = list.complianceFooter;
        break;
      case "physical_address":
        reserved[tag.name] = list.physicalAddress;
        break;
      default:
        throw new Error(`reserved merge tag "${tag.name}" has no resolver in mergeValues`);
    }
  }
  // An attribute only counts as a value if it HAS one. A blank string is what an
  // imported empty cell looks like, and it must not beat the operator's fallback.
  const present: Record<string, string> = {};
  for (const [k, v] of Object.entries(subscriber.attributes)) {
    if (v !== "") present[k] = v;
  }
  // Reserved LAST: subscriber attributes beat per-campaign feed values, and
  // both beat fallbacks; reserved system values cannot be shadowed.
  return { ...fallbacks, ...campaignAttributes, ...present, ...reserved };
}

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
  /** Inbox preview line (#302), rendered hidden at the top of the body. */
  previewText?: string;
  campaignAttributes?: Record<string, string>;
  /** Optional pacing — acquired only for an actual send (skips don't burn tokens). */
  throttle?: SendThrottle;
  /** See SendOptions.unsubscribeLink — same contract for per-recipient sends. */
  unsubscribeLink?: UnsubscribeLinkBuilder;
  /**
   * Marketing (default) or transactional (#237). Only `transactional` relaxes
   * the eligibility gate, and only for suppressions that are statements about
   * marketing — see `SUPPRESSION_BINDING_ON_TRANSACTIONAL`. Omitting it gets the
   * stricter behaviour, so a caller that forgets cannot accidentally bypass it.
   */
  emailClass?: EmailClass;
}

/**
 * May we mail this person at all? (#193)
 *
 * TWO checks, because they fail in different directions and each covers the
 * other's gap. `isSuppressed` is keyed by EMAIL: it is the authoritative,
 * cross-org tombstone, but it goes blind the moment an address changes — rename
 * a complainer and the lookup answers "no entry". `subscriber.status` is keyed
 * by the durable `sub` and survives every rename, but it is org-local and does
 * not know about a global complaint against an address this org has never seen.
 *
 * Nothing consulted `status` before, so a suppressed subscriber whose email
 * changed was mailable while their own record said `suppressed`.
 */
/**
 * Suppression sources that bind a TRANSACTIONAL message too (#237).
 *
 * The line is between a statement about the ADDRESS and a statement about
 * marketing:
 *
 * - `bounce` / `complaint` — the address is dead, or its owner reported us to
 *   their provider. Both bind absolutely. Continuing to mail either is a direct
 *   reputation cost and, for a complaint, an explicit request to stop.
 * - `manual` — an operator suppressed this address deliberately. Treated as
 *   binding: an admin who reaches for the suppression button means "stop
 *   mailing this person", and reading that as "stop the newsletters only" would
 *   silently narrow an instruction we cannot see the reason for.
 * - `unsubscribe` / `inactive` — statements about MARKETING. Someone who leaves
 *   a newsletter, or who stopped opening it, has said nothing about the receipt
 *   or the password reset they trigger ten minutes later, and withholding those
 *   is its own failure.
 */
const SUPPRESSION_BINDING_ON_TRANSACTIONAL = new Set<SuppressionSource>([
  "bounce",
  "complaint",
  "manual",
]);

/**
 * May we send this class of message to this subscriber? (§4.13, #193, #237)
 *
 * Two checks, because the identifier differs. `status` is keyed by the durable
 * `sub` and survives every rename, but it is org-local and does not know about a
 * global complaint against an address this org has never seen. Nothing consulted
 * `status` before, so a suppressed subscriber whose email changed was mailable
 * while their own record said `suppressed`.
 *
 * `emailClass` decides how much of that binds. It defaults to `marketing`, the
 * STRICTER reading: a caller that forgets to declare its class gets the safe
 * behaviour, not a bypass of the whole gate.
 */
async function mayMail(
  stores: Stores,
  orgId: string,
  subscriber: Subscriber,
  emailClass: EmailClass = "marketing",
): Promise<boolean> {
  if (emailClass !== "transactional") {
    if (subscriber.status === "suppressed") return false;
    return !(await stores.suppression.isSuppressed(orgId, subscriber.email));
  }

  // Transactional. `isSuppressed` alone cannot answer this — it is a boolean
  // that folds every source together — so read the entries and look at WHY.
  const entries = await stores.suppression.entriesFor(orgId, subscriber.email);
  if (entries.some((e) => SUPPRESSION_BINDING_ON_TRANSACTIONAL.has(e.source))) return false;

  // The subscriber-level flag has no source attached, so it is ambiguous on its
  // own. Resolve it against the entries: a `suppressed` subscriber with NO
  // binding entry (and, above, no entry at all) is one whose suppression came
  // from an unsubscribe or an inactivity sweep, and transactional mail is still
  // legitimate. If the flag is set and we found no entries at all, fail closed —
  // an unexplained suppression is not one to reason past.
  if (subscriber.status === "suppressed" && entries.length === 0) return false;
  return true;
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
  // One expression, used for both the claim and its release. They were built
  // separately and had to agree by inspection; a claim released under a
  // different key is a subscriber who can never be sent this campaign again.
  const claimKey = sendClaimKey(input.campaignId, input.subscriberId);
  if (!(await stores.sendClaims.claim(input.orgId, claimKey))) {
    return { sent: false, reason: "already-sent" };
  }
  // Any exit that does NOT dispatch must give the claim back, or a transient
  // failure permanently prevents this subscriber from ever receiving the step —
  // which, in the re-engagement sweep, then sunsets them unread (#163, #181).
  const release = () => stores.sendClaims.release(input.orgId, claimKey);

  const subscriber = await stores.subscribers.get(input.orgId, input.subscriberId);
  if (!subscriber) {
    await release();
    return { sent: false, reason: "unknown-subscriber" };
  }
  if (!(await mayMail(stores, input.orgId, subscriber, input.emailClass))) {
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
    const html = renderForRecipient(
      input.template,
      await mergeValues(
        list,
        subscriber,
        input.unsubscribeLink,
        await mergeTagFallbacks(stores, input.orgId),
        input.campaignAttributes,
      ),
      token,
      input.previewText,
    );
    await sender.send({
      emailClass: input.emailClass ?? "marketing",
      from: list.fromAddress,
      to: subscriber.email,
      subject: input.subject,
      html,
      // Same reasoning as the campaign path — a drip step is a newsletter too.
      text: plainTextFrom(html),
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

  // Lifecycle gate: a paused or archived one-off never sends (§4.6). Recurring
  // editions carry an edition-stamped id with no schedule record here — they're
  // gated upstream in the launch handler — so this only bites one-offs.
  //
  // PAUSED and ARCHIVED are not the same and used to behave identically (#179).
  // The one-off's EventBridge schedule has already fired and deleted itself by
  // the time we get here, and returning `skipped` lets SQS delete the message —
  // so a pause destroyed the send outright and Resume-then-Start produced
  // nothing, silently. A paused send is now PARKED on its lifecycle record and
  // re-enqueued on resume; an archived one is genuinely dropped, which is what
  // archive is for.
  const schedule = await stores.schedules.get(input.orgId, input.campaignId);
  if (!scheduleActive(schedule)) {
    // Pause SKIPS the firing; it does not park it (#304).
    //
    // A paused one-off used to be stored on its lifecycle record and
    // re-enqueued on resume, so resuming days later mailed a send nobody
    // expected, with content that had gone stale. Recurring already skipped —
    // the launch handler returns `{skipped}` and the next firing is a fresh
    // edition — and one-offs now match: a missed send stays missed, and an
    // operator who still wants it reschedules or duplicates it, which is an
    // explicit act rather than a surprise.
    //
    // The old parking existed because pause used to DESTROY the send outright
    // (#179). Skipping is the third option: the lifecycle record and the
    // campaign both survive, so nothing is lost except the firing.
    return { sent: 0, suppressed: 0, skipped: true };
  }

  // Series-bound ad fills are resolved after the lifecycle gate so paused or
  // archived messages do not perform an unnecessary series read. Keep the
  // descriptor's authored body as the base: a retry should re-read the current
  // series fill, while the overlay itself remains a pure copy operation.
  const series = input.seriesId
    ? await stores.series.get(input.orgId, input.seriesId)
    : undefined;
  if (input.seriesId && !series) {
    throw new Error(`unknown campaign series ${input.seriesId}`);
  }
  const template = series
    ? applySeriesAdFills(input.template, series.adSlotFills)
    : input.template;
  if (templateIsEmpty(template)) {
    throw new Error(`refusing to send empty template for campaign ${input.campaignId}`);
  }

  // Archive the generic body (§4.8) — powers the click overlay. Deterministic
  // put keyed by campaignId, so repeating it across slices is harmless.
  const linkMap = buildLinkMap(template);
  const archive: EmailArchive = {
    orgId: input.orgId,
    campaignId: input.campaignId,
    s3Key: `archive/${input.orgId}/${input.campaignId}.html`,
    linkMap,
  };
  await stores.archive.put(archive);
  if (opts.archiveBody) {
    await opts.archiveBody.put(
      archive.s3Key,
      // Preheader included: this generic render is what the archive and any
      // past-editions view show, and an edition missing its preview line there
      // would not match what subscribers received.
      renderForRecipient(template, {}, undefined, input.previewText),
    );
  }

  // Dev orgs gate every recipient against their allowlist (§4.11). One org read
  // per campaign/slice, not per recipient.
  const org = await stores.organizations.get(input.orgId);

  // The org's configured merge-tag fallbacks (#266). Read ONCE per slice, for
  // the same reason as the org above: the registry is org-wide and static for
  // the duration of a send, and reading it inside the loop would be one store
  // query per recipient on the hottest path in the system.
  const fallbacks = await mergeTagFallbacks(stores, input.orgId);

  // The slice's key range is pushed into the QUERY (#182). This used to read the
  // whole confirmed list and then discard everything outside the window, so a
  // 250-slice campaign performed 250 full-list reads to send 250 windows —
  // quadratic in list size, on the hottest path in the system.
  //
  // Segment narrowing happens after, on the already-windowed rows, so a
  // segment-targeted slice never materializes the whole list either (#203).
  const windowed = await stores.subscriptions.confirmedRange(
    input.orgId,
    input.listId,
    input.slice,
  );
  const all = await segmentRecipients(
    stores,
    windowed,
    input.orgId,
    input.segmentId,
    opts.segments,
  );
  // Re-sorted rather than trusted: the index returns subscriber-id order, and
  // the ranges are expressed in that order (#171), but a store that ever
  // returned rows unordered would silently break the window boundaries.
  const confirmed = [...all].sort((a, b) => a.subscriberId.localeCompare(b.subscriberId));
  let sent = 0;
  let suppressed = 0;
  let devBlocked = 0;
  let alreadySent = 0;
  const claimedRecipients: string[] = [];
  let untokenized = 0;
  /** Per-recipient SES rejections this slice (#293). */
  let rejected = 0;
  /**
   * Consecutive rejections, reset by any success. The breaker reads this rather
   * than the total so a list with a scattering of genuinely bad addresses keeps
   * sending, while a systemic fault — every recipient rejected — aborts fast.
   */
  let consecutiveRejects = 0;

  // Deliverability halt (§4.13, #165). checkDeliverability flips the campaign to
  // "halted" on a bounce/complaint breach — or, for send ids with no Campaign
  // record (recurring editions, drip, re-engagement), writes a halt MARKER,
  // which is the only place those sends can be stopped. Re-checked periodically
  // inside the loop, because a breach detected mid-send must stop the
  // remainder — not just the next campaign.
  const isHalted = async () =>
    (await stores.campaigns.get(input.orgId, input.campaignId))?.status === "halted" ||
    (await stores.halts.isHalted(input.orgId, input.campaignId));
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

    // Suppression enforced before every send (§4.4, §4.13), by address AND by
    // subscriber status — see mayMail.
    if (!(await mayMail(stores, input.orgId, subscriber))) {
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
    if (!(await stores.sendClaims.claim(input.orgId, sendClaimKey(input.campaignId, subscriber.sub)))) {
      alreadySent++;
      claimedRecipients.push(subscriber.sub);
      continue;
    }

    // Throttle only actual sends so skipped/suppressed rows don't burn tokens.
    if (opts.throttle) await opts.throttle.acquire();

    try {
      const token = await mintToken(magic, subscriber);
      if (magic && token === undefined) untokenized++;
      const html = renderForRecipient(
        template,
        await mergeValues(list, subscriber, opts.unsubscribeLink, fallbacks, input.campaignAttributes),
        token,
        input.previewText,
      );

      await sender.send({
        from: list.fromAddress,
        to: subscriber.email,
        subject: input.subject,
        html,
        // `SentMessage.text` has existed since the port was written and nothing
        // ever set it on a campaign send, so every newsletter went out HTML-only
        // (#204, #200). A missing text part is a spam-score signal at every major
        // provider, and it is simply broken for people who read mail as text.
        // Derived from the rendered HTML rather than authored twice, because two
        // bodies drift and the one nobody looks at is the one that drifts.
        text: plainTextFrom(html),
        listUnsubscribe: await listUnsubscribeHeader(list, subscriber.sub, opts.unsubscribeLink),
        tags: { orgId: input.orgId, campaignId: input.campaignId, subscriberId: subscriber.sub },
      });
    } catch (e) {
      // A PER-RECIPIENT rejection: this address is unsendable, the rest of the
      // slice is not (#293). Keep the claim — retrying this address would fail
      // identically — record it, and carry on.
      //
      // Before this, the throw below aborted the loop for every error, so one
      // permanently-rejected address stranded everyone after it: SQS redelivered,
      // the claims skipped the sent prefix, the loop hit the same address, and it
      // failed the same way until the message dead-lettered. On a 10-recipient
      // list with one bad address at position 4 that was 3 delivered and 6 never
      // mailed, with DLQ depth as the only signal.
      if (e instanceof RecipientRejectedError) {
        const rejection: RecipientRejectedError = e;
        // A fixed literal: a CloudWatch metric filter matches it, because this
        // path no longer reaches the DLQ and would otherwise be silent.
        console.error("send: recipient rejected", {
          orgId: input.orgId,
          campaignId: input.campaignId,
          subscriberId: subscriber.sub,
          error: rejection.message,
        });
        await stores.events.append({
          orgId: input.orgId,
          subscriberId: subscriber.sub,
          campaignId: input.campaignId,
          // NOT `bounce`: no receiver refused anything, so suppressing the
          // address would punish a subscriber for our fault. `reject` already
          // means exactly this (#241).
          type: "reject",
          at: clock.now().toISOString(),
        });
        rejected++;
        // The breaker. An account-wide fault that the adapter misclassified —
        // an unverified FROM identity raises the same MessageRejected — would
        // otherwise write one reject per recipient and report a completed send
        // that mailed nobody, which is worse than aborting. Consecutive, so a
        // scattering of genuinely bad addresses never trips it.
        if (++consecutiveRejects >= MAX_CONSECUTIVE_REJECTS) {
          throw new Error(
            `send aborted: ${consecutiveRejects} consecutive recipient rejections — ` +
              `this is an account-level fault, not ${consecutiveRejects} bad addresses ` +
              `(last: ${rejection.message})`,
          );
        }
        continue;
      }
      // Everything else — throttling, quota, suspended account, 5xx, network —
      // means the NEXT recipient would fail too, so abort and let SQS retry the
      // slice. The claim guards a dispatch that did not happen; give it back so
      // the retry re-attempts THIS recipient instead of skipping them forever.
      await stores.sendClaims.release(input.orgId, sendClaimKey(input.campaignId, subscriber.sub));
      throw e;
    }
    consecutiveRejects = 0;

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

  if (!halted && schedule?.kind === "one_off" && !(await isHalted())) {
    // A claim alone may belong to another worker still inside sender.send.
    // Never complete its window before that dispatch has a durable sent event.
    if (claimedRecipients.length > 0) {
      // `reject` is TERMINAL here, not pending (#293). A rejected recipient
      // never gets a `sent` event and never will — retrying that address fails
      // identically — so accepting only `sent` would throw on every retry and
      // dead-letter the message anyway. That would have moved the DLQ loop
      // rather than removed it, which is the whole point of the change.
      const settled = new Set((await stores.events.all(input.orgId, input.campaignId))
        .filter((e) => e.type === "sent" || e.type === "reject").map((e) => e.subscriberId));
      if (claimedRecipients.some((id) => !settled.has(id))) {
        throw new Error("send claims still awaiting recorded delivery; retry completion");
      }
    }
    await completeScheduleRange(stores, clock, input.orgId, input.campaignId, input.slice);
  }

  // `skipped` now means "nothing new to dispatch" — true for a full redelivery
  // (every recipient already claimed), false when a retry delivered a remainder.
  return {
    sent,
    suppressed,
    devBlocked,
    alreadySent,
    untokenized,
    ...(rejected > 0 ? { rejected } : {}),
    // A slice that rejected every recipient did NOT do its job, so it must not
    // report `skipped` (which reads as "already delivered") — that is the shape
    // an operator would scroll past.
    skipped: sent === 0 && alreadySent > 0,
    ...(halted ? { halted: true } : {}),
  };
}
