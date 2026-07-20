/**
 * Deliverability alerting (docs/ARCHITECTURE.md §4.18, §6).
 *
 * When bounce/complaint/failure rates cross an org's configured thresholds we
 * publish to that org's SNS topic (operator-owned) and, on a `halt` breach,
 * flip the campaign to `halted` so the sender stops. Thresholds are per-metric
 * with a warn level and a hard halt level. Pure evaluation lives here; the SNS
 * side effect is an injected `AlertPublisher` so it stays testable.
 */
import type { AlertConfig, HotCounters } from "@addressium/core";
import type { AlertPublisher, Clock, Stores } from "./ports.js";
import { deliverabilityRates, deriveCounters } from "./reporting.js";

export type AlertLevel = "warn" | "halt";

export interface AlertBreach {
  metric: AlertConfig["rules"][number]["metric"];
  level: AlertLevel;
  value: number;
  threshold: number;
}

function metricValue(metric: AlertBreach["metric"], counters: HotCounters): number {
  const r = deliverabilityRates(counters);
  switch (metric) {
    case "complaint_rate":
      return r.complaintRate;
    case "bounce_rate":
      return r.bounceRate;
    case "send_failures":
      // Absolute count of hard failures (bounces + complaints) for this window.
      return counters.bounces + counters.complaints;
    case "reputation":
      // No live reputation signal in the hot path; treated as informational.
      return 0;
  }
}

/** Evaluate an org's rules against a campaign's counters; worst level per metric. */
export function evaluateAlerts(config: AlertConfig, counters: HotCounters): AlertBreach[] {
  const breaches: AlertBreach[] = [];
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    const value = metricValue(rule.metric, counters);
    if (value >= rule.haltAt) {
      breaches.push({ metric: rule.metric, level: "halt", value, threshold: rule.haltAt });
    } else if (value >= rule.warnAt) {
      breaches.push({ metric: rule.metric, level: "warn", value, threshold: rule.warnAt });
    }
  }
  return breaches;
}

export interface DeliverabilityCheckResult {
  breaches: AlertBreach[];
  halted: boolean;
}

/**
 * Load the org's alert config + the campaign's counters, evaluate, publish any
 * breaches to SNS, and halt the campaign if a `halt`-level breach fired.
 * No config → no-op. Safe to call after every bounce/complaint.
 */
export async function checkDeliverability(
  stores: Stores,
  publisher: AlertPublisher,
  clock: Clock,
  orgId: string,
  campaignId: string,
): Promise<DeliverabilityCheckResult> {
  const config = await stores.alerts.get(orgId);
  if (!config) return { breaches: [], halted: false };

  const events = await stores.events.all(orgId, campaignId);
  const counters = deriveCounters(events);
  const breaches = evaluateAlerts(config, counters);
  if (breaches.length === 0) return { breaches, halted: false };

  const halted = breaches.some((b) => b.level === "halt");
  await publisher.publish(config.snsTopicArn, {
    orgId,
    campaignId,
    at: clock.now().toISOString(),
    breaches,
    action: halted ? "halted" : "warned",
  });

  if (halted) {
    const campaign = await stores.campaigns.get(orgId, campaignId);
    if (campaign && campaign.status !== "halted") {
      await stores.campaigns.put({ ...campaign, status: "halted" });
    }
  }
  return { breaches, halted };
}
