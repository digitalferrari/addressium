/**
 * Admin CRUD domain functions (docs/ARCHITECTURE.md §4.1, §4.12, #18).
 *
 * Pure operations over the stores for the authenticated admin surface: create /
 * edit newsletters (incl. open/close), campaign drafts, segments, and manual
 * subscriber suppression. API handlers validate + authorize (RBAC) then call
 * these; org scoping is enforced by the caller's grant and the orgId on each
 * entity. No AWS or HTTP concerns here.
 */
import type {
  Branding,
  Campaign,
  DripSequence,
  HotCounters,
  List,
  ListPresentation,
  ListVisibility,
  Organization,
  Segment,
  Template,
} from "@addressium/core";
import { schemas } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

export const ZERO_COUNTERS: HotCounters = {
  sent: 0,
  delivered: 0,
  opens: 0,
  clicks: 0,
  bounces: 0,
  complaints: 0,
  unsubscribes: 0,
};

/** The domain part of an address, lowercased. Empty string if there isn't one. */
const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/**
 * Is this address on one of the org's own domains, or a subdomain of one? (#200)
 *
 * Subdomains count because an SES domain identity covers them: verifying
 * `example.com` lets you send as `news@mail.example.com`. The suffix check is
 * anchored on a leading dot so `notexample.com` does not match `example.com`.
 */
export function fromAddressAllowed(address: string, orgDomains: string[]): boolean {
  const from = domainOf(address);
  if (!from) return false;
  return orgDomains.some((d) => {
    const owned = d.trim().toLowerCase();
    return owned.length > 0 && (from === owned || from.endsWith(`.${owned}`));
  });
}

/**
 * Create or replace a newsletter/list from a validated payload.
 *
 * The From address is checked against the org's own domains (#200). It used to
 * be taken verbatim, with enforcement left entirely to SES rejecting the send —
 * which means the failure surfaces at SEND time, on a scheduled campaign, as an
 * opaque SES error, rather than at the moment somebody typed the wrong domain
 * into a form. Worse, in a multi-tenant deployment "SES will reject it" is only
 * true across accounts: if two orgs in the same account both verified their
 * domains, org A could set a From address on org B's verified domain and SES
 * would happily send it.
 */
export async function saveList(stores: Stores, input: schemas.CreateListInput): Promise<List> {
  const org = await stores.organizations.get(input.orgId);
  if (!org) throw new Error(`unknown org ${input.orgId}`);
  if (!fromAddressAllowed(input.fromAddress, org.domains)) {
    throw new Error(
      `fromAddress ${input.fromAddress} is not on a domain this org owns (${org.domains.join(", ")}). ` +
        `Sending as a domain you have not verified fails DMARC and, where it is another tenant's ` +
        `verified domain, sends as them.`,
    );
  }
  const list: List = {
    orgId: input.orgId,
    listId: input.listId,
    name: input.name,
    description: input.description,
    optInPolicy: input.optInPolicy,
    fromAddress: input.fromAddress,
    replyTo: input.replyTo,
    access: input.access,
    visibility: input.visibility,
    complianceFooter: input.complianceFooter,
    physicalAddress: input.physicalAddress,
  };
  await stores.lists.put(list);
  return list;
}

/** Open (reopen) or close a newsletter — the destructive control (§4.12). */
export async function setListVisibility(
  stores: Stores,
  orgId: string,
  listId: string,
  visibility: ListVisibility,
): Promise<List> {
  const list = await stores.lists.get(orgId, listId);
  if (!list) throw new Error("unknown list");
  const updated: List = { ...list, visibility };
  await stores.lists.put(updated);
  return updated;
}

/** Save a campaign draft (create or edit). New drafts start at zero counters. */
export async function saveCampaignDraft(
  stores: Stores,
  input: schemas.SaveCampaignInput,
): Promise<Campaign> {
  const existing = await stores.campaigns.get(input.orgId, input.campaignId);
  const campaign: Campaign = {
    orgId: input.orgId,
    campaignId: input.campaignId,
    type: input.type,
    seriesId: input.seriesId,
    subject: input.subject,
    previewText: input.previewText,
    templateId: input.templateId,
    audience: input.audience,
    // Preserve status/counters on edit; new drafts start as "draft".
    status: existing?.status ?? "draft",
    counters: existing?.counters ?? ZERO_COUNTERS,
    // ...and the SCHEDULE (#201). `saveCampaignDraft` rebuilt the record from
    // the input alone, so editing a subject on an already-scheduled campaign
    // silently dropped its send time. The save schema has no `schedule` field —
    // scheduling goes through its own route — so the draft editor could only
    // ever have destroyed this, never set it.
    ...(existing?.schedule ? { schedule: existing.schedule } : {}),
  };
  await stores.campaigns.put(campaign);
  return campaign;
}

/**
 * Save a reusable template (create or edit, §4.15). The stored version bumps on
 * each edit so the archive can pin a specific version. Raw HTML is sanitized at
 * the API boundary before this is called (adapters-aws `sanitizeEmailHtml`);
 * MJML source is stored verbatim and compiled to HTML client-side.
 */
export async function saveTemplate(stores: Stores, input: schemas.SaveTemplateInput): Promise<Template> {
  const existing = await stores.templates.get(input.orgId, input.templateId);
  const template: Template = {
    orgId: input.orgId,
    templateId: input.templateId,
    name: input.name,
    mode: input.mode,
    source: input.source,
    version: (existing?.version ?? 0) + 1,
    mergeTags: input.mergeTags,
    adSlots: input.adSlots,
  };
  // Conditional on the version we just read (#194). Two concurrent saves both
  // compute N+1; without this both write it, one body is lost silently, and the
  // archive believes it pinned two distinct versions when it pinned one twice.
  await stores.templates.put(template, { ifVersion: existing?.version });
  return template;
}

/** Create or update a segment definition. */
export async function saveSegment(stores: Stores, input: schemas.SaveSegmentInput): Promise<Segment> {
  const segment: Segment = {
    orgId: input.orgId,
    segmentId: input.segmentId,
    name: input.name,
    predicate: input.predicate,
  };
  await stores.segments.put(segment);
  return segment;
}

/** One member of an explicit-membership segment, as the console shows them. */
export interface SegmentMember {
  subscriberId: string;
  email: string;
  status: "active" | "suppressed";
  entitlement: "free" | "paid";
  /** True when this address would be skipped at send time (#203). */
  suppressed: boolean;
}

/**
 * Resolve an explicit segment's stored ids into displayable members (#203).
 *
 * Ids that no longer resolve are dropped rather than shown as blanks: a deleted
 * or erased subscriber is not a member, and a console that lists them invites an
 * operator to "fix" a row that is already correct.
 *
 * `suppressed` is computed for display only. The send path enforces it in
 * `mayMail`; showing it here is what stops an operator concluding a test send is
 * broken when it was in fact obeying a suppression.
 */
export async function listSegmentMembers(
  stores: Stores,
  orgId: string,
  segmentId: string,
): Promise<SegmentMember[]> {
  const segment = await stores.segments.get(orgId, segmentId);
  if (!segment) throw new Error(`unknown segment ${segmentId}`);
  const ids = explicitMemberIds(segment.predicate);
  if (!ids) throw new Error(`segment ${segmentId} is rule-based — it has no explicit members`);

  const members: SegmentMember[] = [];
  for (const id of ids) {
    const s = await stores.subscribers.get(orgId, id);
    if (!s) continue;
    members.push({
      subscriberId: s.sub,
      email: s.email,
      status: s.status,
      entitlement: s.entitlement,
      // Both halves, exactly as `mayMail` checks them (#193): a suppression
      // entry OR a suppressed subscriber record. Showing only one would tell the
      // operator an address is mailable when the send path disagrees.
      suppressed: s.status === "suppressed" || (await stores.suppression.isSuppressed(orgId, s.email)),
    });
  }
  return members;
}

/** The member ids of an explicit predicate, or `undefined` if it is rule-based. */
function explicitMemberIds(predicate: unknown): string[] | undefined {
  const p = predicate as { match?: unknown; subscriberIds?: unknown };
  if (!p || p.match !== "explicit") return undefined;
  return Array.isArray(p.subscriberIds) ? (p.subscriberIds as string[]) : [];
}

/**
 * Add or remove one address from an explicit-membership segment (#203).
 *
 * **An address that is not already a subscriber is REJECTED**, not created. The
 * issue offered both; this is the choice and the reason: every other path that
 * creates a subscriber records consent provenance — a signup captures the source
 * URL and timestamp, an import captures a consent basis and a batch id. A
 * subscriber conjured from a segment-editor text box has none of that, and the
 * record is indistinguishable afterwards from one that does. Building a test
 * cohort is not a lawful basis for mailing someone. The operator imports or adds
 * the address first, which takes one screen and leaves provenance behind.
 */
export async function updateSegmentMembership(
  stores: Stores,
  input: schemas.SegmentMemberInput,
): Promise<{ segment: Segment; members: SegmentMember[] }> {
  const segment = await stores.segments.get(input.orgId, input.segmentId);
  if (!segment) throw new Error(`unknown segment ${input.segmentId}`);
  const ids = explicitMemberIds(segment.predicate);
  if (!ids) {
    throw new Error(
      `segment ${input.segmentId} is rule-based — its members come from its conditions, not a list`,
    );
  }

  const email = input.email.trim().toLowerCase();
  const subscriber = await stores.subscribers.findByEmail(input.orgId, email);
  if (!subscriber) {
    throw new Error(
      `${email} is not a subscriber in this organization — import or add them first, so their consent provenance is recorded`,
    );
  }

  const next =
    input.action === "add"
      ? ids.includes(subscriber.sub)
        ? ids // idempotent: adding twice is not an error, and must not duplicate
        : [...ids, subscriber.sub]
      : ids.filter((id) => id !== subscriber.sub);

  const updated: Segment = {
    ...segment,
    predicate: { match: "explicit", subscriberIds: next },
  };
  await stores.segments.put(updated);
  return { segment: updated, members: await listSegmentMembers(stores, input.orgId, input.segmentId) };
}

/** Create/update a drip sequence (§4.6, #104). */
export async function saveDripSequence(
  stores: Stores,
  input: schemas.SaveDripSequenceInput,
): Promise<DripSequence> {
  const sequence: DripSequence = {
    orgId: input.orgId,
    sequenceId: input.sequenceId,
    name: input.name,
    trigger: input.trigger,
    steps: input.steps,
  };
  await stores.dripSequences.put(sequence);
  return sequence;
}

/** Set the org's subscriber-site branding/theme (§4.10, #31). */
export async function setBranding(
  stores: Stores,
  orgId: string,
  branding: Branding,
): Promise<Organization> {
  const org = await stores.organizations.get(orgId);
  if (!org) throw new Error("unknown org");
  const updated: Organization = { ...org, branding };
  await stores.organizations.put(updated);
  return updated;
}

/** Set a list's subscriber-site presentation toggles (§4.10, #33). */
export async function setListPresentation(
  stores: Stores,
  orgId: string,
  listId: string,
  presentation: ListPresentation,
): Promise<List> {
  const list = await stores.lists.get(orgId, listId);
  if (!list) throw new Error("unknown list");
  const updated: List = { ...list, presentation };
  await stores.lists.put(updated);
  return updated;
}

export interface AudienceCounts {
  total: number;
  free: number;
  paid: number;
}

/** Confirmed-subscriber counts for a list, split by entitlement (reader/free/paid). */
export async function listAudienceCounts(
  stores: Stores,
  orgId: string,
  listId: string,
): Promise<AudienceCounts> {
  const confirmed = await stores.subscriptions.listConfirmed(orgId, listId);
  const counts: AudienceCounts = { total: confirmed.length, free: 0, paid: 0 };
  for (const sub of confirmed) {
    const subscriber = await stores.subscribers.get(orgId, sub.subscriberId);
    if (subscriber?.entitlement === "paid") counts.paid++;
    else counts.free++;
  }
  return counts;
}

/**
 * Public subscriber-site view of a list: description + presentation toggles, and
 * the aggregate counts ONLY when their toggle is on (never a subscriber roster).
 */
export async function publicListView(
  stores: Stores,
  orgId: string,
  listId: string,
): Promise<{
  listId: string;
  name: string;
  description?: string;
  presentation: ListPresentation;
  frequencyLabel?: string;
  sendTimeLabel?: string;
  readerCount?: number;
  freePaidCount?: { free: number; paid: number };
} | undefined> {
  const list = await stores.lists.get(orgId, listId);
  if (!list) return undefined;
  const p: ListPresentation = list.presentation ?? {
    showFrequency: false,
    showSendTime: false,
    showDescription: true,
    showReaderCount: false,
    showFreePaidCount: false,
  };
  const needCounts = p.showReaderCount || p.showFreePaidCount;
  const counts = needCounts ? await listAudienceCounts(stores, orgId, listId) : undefined;
  return {
    listId: list.listId,
    name: list.name,
    description: p.showDescription ? list.description : undefined,
    presentation: p,
    frequencyLabel: p.showFrequency ? p.frequencyLabel : undefined,
    sendTimeLabel: p.showSendTime ? p.sendTimeLabel : undefined,
    readerCount: p.showReaderCount ? counts?.total : undefined,
    freePaidCount: p.showFreePaidCount && counts ? { free: counts.free, paid: counts.paid } : undefined,
  };
}

/**
 * The public newsletter directory (#124).
 *
 * The subscriber site was calling the ADMIN `GET /orgs/{org}/lists`, which is
 * behind the console's JWT authorizer — so the browse page, the front door of
 * the whole public site, could only ever have returned 401.
 *
 * Reusing that handler by making it public would have been the wrong fix twice
 * over. It returns every list including **closed** ones, which a directory must
 * not advertise, and it returns `fromAddress`, `complianceFooter` and
 * `physicalAddress` — operational fields that belong to the operator, not to
 * anyone who loads a web page. This returns the same shape `publicListView`
 * already established for a single list, for the lists a stranger may see.
 */
export async function publicListDirectory(
  stores: Stores,
  orgId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof publicListView>>>[]> {
  const lists = await stores.lists.list(orgId);
  const out: NonNullable<Awaited<ReturnType<typeof publicListView>>>[] = [];
  for (const l of lists) {
    // `closed` means "not accepting signups"; showing it in a directory invites
    // people to a door that will not open.
    if (l.visibility === "closed") continue;
    const view = await publicListView(stores, orgId, l.listId);
    if (view) out.push(view);
  }
  // Stable, name-ordered — a directory whose order shifts between loads reads
  // as broken.
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Manually suppress an address (admin action): add an org-scoped suppression
 * entry and, if the subscriber exists, flip it to `suppressed`. Returns whether
 * a subscriber record was flipped.
 */
export async function manualSuppress(
  stores: Stores,
  clock: Clock,
  input: { orgId: string; email: string },
): Promise<{ suppressed: true; subscriberFlipped: boolean }> {
  const email = input.email.toLowerCase();
  await stores.suppression.add({
    orgId: input.orgId,
    email,
    source: "manual",
    scope: "org",
    addedAt: clock.now().toISOString(),
  });
  const subscriber = await stores.subscribers.findByEmail(input.orgId, email);
  if (subscriber && subscriber.status !== "suppressed") {
    await stores.subscribers.put({ ...subscriber, status: "suppressed" });
    return { suppressed: true, subscriberFlipped: true };
  }
  return { suppressed: true, subscriberFlipped: false };
}

/**
 * Lift an org-scoped suppression (#102) — the inverse of manualSuppress. Removes
 * the org suppression entry and flips a suppressed subscriber back to active so
 * they can receive mail again. Global entries (hard bounces/complaints) are NOT
 * lifted here — those are deployment-wide and must be cleared deliberately.
 */
export async function liftSuppression(
  stores: Stores,
  input: { orgId: string; email: string },
): Promise<{ lifted: true; subscriberReactivated: boolean }> {
  const email = input.email.toLowerCase();
  await stores.suppression.remove(input.orgId, email, "org");
  const subscriber = await stores.subscribers.findByEmail(input.orgId, email);
  if (subscriber && subscriber.status === "suppressed") {
    await stores.subscribers.put({ ...subscriber, status: "active" });
    return { lifted: true, subscriberReactivated: true };
  }
  return { lifted: true, subscriberReactivated: false };
}
