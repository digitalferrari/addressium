/**
 * Usage & cost metering (docs/ARCHITECTURE.md §11, #26).
 *
 * Aggregates per-org usage for a billing period and applies a configurable cost
 * model for chargeback across publications. Email volume comes from our own
 * counters; storage and dedicated-IP figures come from AWS metrics (CloudWatch /
 * Cost & Usage Report) fed in by the metering service. The cost model is pure so
 * it's exercised directly in tests and stays independent of the data source.
 */
import type { Campaign, CostRates, EngagementEvent, UsageRecord } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

/** Illustrative us-east-1-ish defaults; operators override per deployment. */
export const DEFAULT_COST_RATES: CostRates = {
  perEmail: 0.0001, // $0.10 / 1,000 messages
  perGbStorageMonth: 0.023,
  perDedicatedIpMonth: 24.95,
  perTbScanned: 5.0, // Athena: $5 / TB scanned
};

const BYTES_PER_GB = 1_073_741_824;
const BYTES_PER_TB = 1_099_511_627_776;

export interface UsageInputs {
  orgId: string;
  period: string; // "YYYY-MM"
  emailsSent: number;
  storageBytes: number;
  dedicatedIps: number;
  /** Athena bytes scanned this period; optional (0 when the analytics tier is off). */
  athenaBytesScanned?: number;
}

export function estimateCost(inputs: UsageInputs, rates: CostRates): UsageRecord["cost"] {
  const email = inputs.emailsSent * rates.perEmail;
  const storage = (inputs.storageBytes / BYTES_PER_GB) * rates.perGbStorageMonth;
  const dedicatedIp = inputs.dedicatedIps * rates.perDedicatedIpMonth;
  const athena = ((inputs.athenaBytesScanned ?? 0) / BYTES_PER_TB) * rates.perTbScanned;
  return { email, storage, dedicatedIp, athena, total: email + storage + dedicatedIp + athena };
}

/** Sum "emailsSent" from a set of campaigns' hot counters (our own metric). */
export function sumEmailsSent(campaigns: Campaign[]): number {
  return campaigns.reduce((n, c) => n + (c.counters?.sent ?? 0), 0);
}

/** The billing period ("YYYY-MM") an ISO-8601 instant falls in. Storage is UTC (§4.21). */
export function usagePeriodOf(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * Emails actually sent inside one billing period (#199).
 *
 * `sumEmailsSent` above folds campaign COUNTERS, which are lifetime totals: used
 * for a month it reports every email the org has ever sent, and reports it again
 * next month. Metering needs a period-scoped figure, and the append-only event
 * log is the only thing that carries a timestamp per send.
 */
export function emailsSentInPeriod(events: EngagementEvent[], period: string): number {
  let n = 0;
  for (const e of events) if (e.type === "sent" && usagePeriodOf(e.at) === period) n++;
  return n;
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
    athenaBytesScanned: inputs.athenaBytesScanned ?? 0,
    cost: estimateCost(inputs, rates),
    computedAt: clock.now().toISOString(),
  };
  await stores.usage.put(record);
  return record;
}

/**
 * Meter one org for one period from data this deployment actually holds (#199).
 *
 * The split matters, because the Usage screen previously showed a permanent $0
 * for everything: **email volume** is ours — it comes from the event log — while
 * **storageBytes / dedicatedIps / athenaBytesScanned** come from AWS billing and
 * CloudWatch, which this stack does not read. So those three are CARRIED FORWARD
 * from whatever an operator's metering job last fed in through
 * `usageIngestHandler`, rather than being recomputed as zero.
 *
 * That carry-forward is the whole point of doing this as a merge. A nightly job
 * that wrote `storageBytes: 0` would silently erase the operator's real figures
 * every night, and the screen would go back to reading $0 — the same defect in a
 * more expensive costume.
 *
 * Athena in particular can never be derived here: its CloudWatch metrics are
 * dimensioned by WORKGROUP and there is one workgroup per stage, so per-org
 * attribution is not something the stack can compute at all.
 */
export async function meterOrgUsage(
  stores: Stores,
  clock: Clock,
  orgId: string,
  period: string,
  rates: CostRates = DEFAULT_COST_RATES,
): Promise<UsageRecord> {
  const campaigns = await stores.campaigns.list(orgId);
  let emailsSent = 0;
  for (const c of campaigns) {
    emailsSent += emailsSentInPeriod(await stores.events.all(orgId, c.campaignId), period);
  }
  const prior = await stores.usage.get(orgId, period);
  return recordUsage(
    stores,
    clock,
    {
      orgId,
      period,
      emailsSent,
      storageBytes: prior?.storageBytes ?? 0,
      dedicatedIps: prior?.dedicatedIps ?? 0,
      athenaBytesScanned: prior?.athenaBytesScanned ?? 0,
    },
    rates,
  );
}
