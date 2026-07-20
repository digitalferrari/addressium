/**
 * Admin CRUD domain functions (docs/ARCHITECTURE.md §4.1, §4.12, #18).
 *
 * Pure operations over the stores for the authenticated admin surface: create /
 * edit newsletters (incl. open/close), campaign drafts, segments, and manual
 * subscriber suppression. API handlers validate + authorize (RBAC) then call
 * these; org scoping is enforced by the caller's grant and the orgId on each
 * entity. No AWS or HTTP concerns here.
 */
import type { AiConfig, Campaign, HotCounters, List, ListVisibility, Organization, Segment } from "@addressium/core";
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
