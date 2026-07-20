/**
 * Reporting aggregation — hot counters + deliverability rates (§4.8, §7).
 *
 * The EventStore is the source of truth; `deriveCounters` folds the append-only
 * engagement events into the same HotCounters shape carried on the Campaign
 * record, so a real-time dashboard read and the materialized counter agree.
 * Opens/clicks are counted UNIQUE per subscriber (matching the click map);
 * sent/bounce/complaint/unsubscribe are raw counts. The deep-analysis tier
 * (Firehose → S3 → Athena) is wired in infra; this is the hot read path.
 */
import type { EngagementEvent, HotCounters } from "@addressium/core";
import type { Stores } from "./ports.js";
import { buildClickMap, type ClickMap } from "./events.js";

export function deriveCounters(events: EngagementEvent[]): HotCounters {
  const raw = (type: EngagementEvent["type"]) => events.filter((e) => e.type === type).length;
  const uniq = (type: EngagementEvent["type"]) =>
    new Set(events.filter((e) => e.type === type).map((e) => e.subscriberId)).size;
  return {
    sent: raw("sent"),
    delivered: raw("delivered"),
    opens: uniq("open"),
    clicks: uniq("click"),
    bounces: raw("bounce"),
    complaints: raw("complaint"),
    unsubscribes: raw("unsubscribe"),
  };
}

export interface DeliverabilityRates {
  /** Fractions in [0,1], relative to messages sent (0 when nothing sent). */
  openRate: number;
  clickRate: number;
  bounceRate: number;
  complaintRate: number;
}

export function deliverabilityRates(c: HotCounters): DeliverabilityRates {
  const denom = c.sent > 0 ? c.sent : 1;
  return {
    openRate: c.opens / denom,
    clickRate: c.clicks / denom,
    bounceRate: c.bounces / denom,
    complaintRate: c.complaints / denom,
  };
}

export interface CampaignReport {
  orgId: string;
  campaignId: string;
  counters: HotCounters;
  rates: DeliverabilityRates;
  clickMap: ClickMap;
}

/** Build the full hot-path report for one campaign (counters + rates + click map). */
export async function buildCampaignReport(
  stores: Stores,
  orgId: string,
  campaignId: string,
): Promise<CampaignReport> {
  const events = await stores.events.all(orgId, campaignId);
  const counters = deriveCounters(events);
  const clickMap = await buildClickMap(stores, orgId, campaignId);
  return { orgId, campaignId, counters, rates: deliverabilityRates(counters), clickMap };
}
