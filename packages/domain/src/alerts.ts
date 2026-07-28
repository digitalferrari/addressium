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

/**
 * Thresholds a newly provisioned org starts with (#217).
 *
 * A control that is off by default is not a control: before this, every org
 * deployed with NO alert config, `checkDeliverability` short-circuited on the
 * missing record, and the auto-halt README advertises could never fire on any
 * real install. Defaults make it fire; the operator tunes or disables it.
 *
 * The numbers follow the thresholds mailbox providers actually act on — Google
 * Postmaster treats a 0.3% complaint rate as the level to stay under, so the
 * warn sits there and the halt at 0.5%. Bounce rates above 5% put an SES
 * account under review, so warn at 5% and halt at 10%.
 */
export const DEFAULT_ALERT_RULES: AlertConfig["rules"] = [
  { metric: "complaint_rate", warnAt: 0.003, haltAt: 0.005, enabled: true },
  { metric: "bounce_rate", warnAt: 0.05, haltAt: 0.1, enabled: true },
  // Informational only until a live reputation signal exists (metricValue
  // returns 0), so it is off — an always-zero rule would never fire anyway and
  // leaving it enabled implies a signal we do not have.
  { metric: "reputation", warnAt: 0, haltAt: 0, enabled: false },
];

/** The config a newly provisioned org gets, so protection is never opt-in. */
export function defaultAlertConfig(orgId: string, snsTopicArn?: string): AlertConfig {
  return {
    orgId,
    snsTopicArn,
    rules: DEFAULT_ALERT_RULES.map((r) => ({ ...r })),
    notifyTargets: [],
  };
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
  // Notification is best-effort; halting is not. An org with no topic still
  // stops the campaign, and a publish failure must not prevent the halt — the
  // whole point is to stop sending to a list that is generating complaints.
  if (config.snsTopicArn) {
    try {
      await publisher.publish(config.snsTopicArn, {
        orgId,
        campaignId,
        at: clock.now().toISOString(),
        breaches,
        action: halted ? "halted" : "warned",
      });
    } catch (e) {
      console.error("alerts: publish failed, continuing to halt", {
        orgId,
        campaignId,
        error: (e as Error).message,
      });
    }
  }

  if (halted) {
    const campaign = await stores.campaigns.get(orgId, campaignId);
    if (campaign && campaign.status !== "halted") {
      await stores.campaigns.put({ ...campaign, status: "halted" });
    }
  }
  return { breaches, halted };
}
