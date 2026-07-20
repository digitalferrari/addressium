/**
 * Usage & cost metering (docs/ARCHITECTURE.md §11, #26).
 *
 * Aggregates per-org usage for a billing period and applies a configurable cost
 * model for chargeback across publications. Email volume comes from our own
 * counters; storage and dedicated-IP figures come from AWS metrics (CloudWatch /
 * Cost & Usage Report) fed in by the metering service. The cost model is pure so
 * it's exercised directly in tests and stays independent of the data source.
 */
import type { Campaign, CostRates, UsageRecord } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

/** Illustrative us-east-1-ish defaults; operators override per deployment. */
export const DEFAULT_COST_RATES: CostRates = {
  perEmail: 0.0001, // $0.10 / 1,000 messages
  perGbStorageMonth: 0.023,
  perDedicatedIpMonth: 24.95,
};

export interface UsageInputs {
  orgId: string;
  period: string; // "YYYY-MM"
  emailsSent: number;
  storageBytes: number;
  dedicatedIps: number;
}

export function estimateCost(inputs: UsageInputs, rates: CostRates): UsageRecord["cost"] {
  const email = inputs.emailsSent * rates.perEmail;
  const storage = (inputs.storageBytes / 1_073_741_824) * rates.perGbStorageMonth;
  const dedicatedIp = inputs.dedicatedIps * rates.perDedicatedIpMonth;
  return { email, storage, dedicatedIp, total: email + storage + dedicatedIp };
}

/** Sum "emailsSent" from a set of campaigns' hot counters (our own metric). */
export function sumEmailsSent(campaigns: Campaign[]): number {
  return campaigns.reduce((n, c) => n + (c.counters?.sent ?? 0), 0);
}

/** Build + persist the usage record for an org/period, applying the cost model. */
export async function recordUsage(
  stores: Stores,
  clock: Clock,
  inputs: UsageInputs,
  rates: CostRates = DEFAULT_COST_RATES,
): Promise<UsageRecord> {
  const record: UsageRecord = {
    orgId: inputs.orgId,
    period: inputs.period,
    emailsSent: inputs.emailsSent,
    storageBytes: inputs.storageBytes,
    dedicatedIps: inputs.dedicatedIps,
    cost: estimateCost(inputs, rates),
    computedAt: clock.now().toISOString(),
  };
  await stores.usage.put(record);
  return record;
}
