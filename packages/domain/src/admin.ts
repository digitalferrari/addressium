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
  AiConfig,
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

const ZERO_COUNTERS: HotCounters = {
  sent: 0,
  delivered: 0,
  opens: 0,
  clicks: 0,
  bounces: 0,
  complaints: 0,
  unsubscribes: 0,
};

/** Create or replace a newsletter/list from a validated payload. */
export async function saveList(stores: Stores, input: schemas.CreateListInput): Promise<List> {
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
  await stores.templates.put(template);
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

/** Set the org's LLM analytics provider (§4.8, #32). Key is already in Secrets Manager. */
export async function setAiConfig(
  stores: Stores,
  orgId: string,
  aiConfig: AiConfig,
): Promise<Organization> {
  const org = await stores.organizations.get(orgId);
  if (!org) throw new Error("unknown org");
  const updated: Organization = { ...org, aiConfig };
  await stores.organizations.put(updated);
  return updated;
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
