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
    rejects: raw("reject"),
    renderingFailures: raw("rendering_failure"),
    // Raw, not unique: the same message can be delayed several times, and each
    // one is a separate signal about the receiver. Collapsing them would hide a
    // receiver deferring the whole campaign repeatedly.
    deliveryDelays: raw("delivery_delay"),
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
  // ONE read of the event log, not two (#182). This read the whole log to derive
  // counters and then called `buildClickMap`, which read it again — two full
  // reads of an unbounded item set to render one screen.
  const events = await stores.events.all(orgId, campaignId);
  // Prefer the STORED counters. They are maintained transactionally with each
  // append (#221) and are what `checkDeliverability` evaluates, so using them
  // here means the bounce rate an operator reads is the same number that halted
  // the campaign — deriving separately let the report and the halt disagree.
  const campaign = await stores.campaigns.get(orgId, campaignId);
  const counters = campaign?.counters ?? deriveCounters(events);
  const clickMap = await buildClickMap(stores, orgId, campaignId, events);
  return { orgId, campaignId, counters, rates: deliverabilityRates(counters), clickMap };
}
