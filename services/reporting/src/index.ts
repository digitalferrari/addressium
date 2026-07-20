/**
 * addressium service: reporting — hot-path campaign analytics (§4.8, §7).
 *
 * GET report for a campaign: derives HotCounters + deliverability rates from the
 * append-only event log and returns the click-overlay map. Deep, ad-hoc
 * analysis (funnels, series roll-ups, A/B) runs off the Firehose → S3 → Athena
 * tier wired in infra; this endpoint is the low-latency dashboard read.
 */
import { DynamoStores } from "@addressium/adapters-aws";
import { SystemClock, buildAbReport, buildCampaignReport, recordUsage } from "@addressium/domain";

const clock = new SystemClock();

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));

export interface ReportEvent {
  pathParameters?: { org?: string; campaign?: string } | null;
  orgId?: string;
  campaignId?: string;
}

export async function handler(event: ReportEvent) {
  const orgId = event.pathParameters?.org ?? event.orgId;
  const campaignId = event.pathParameters?.campaign ?? event.campaignId;
  if (!orgId || !campaignId) {
    return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "org and campaign required" }) };
  }
  const s = stores();
  const report = await buildCampaignReport(s, orgId, campaignId);
  // If this campaign ran an A/B subject test, attach the per-variant scores.
  const campaign = await s.campaigns.get(orgId, campaignId);
  const abResults = campaign?.abTest
    ? await buildAbReport(s, campaignId, orgId, campaign.abTest)
    : undefined;
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "private, max-age=15" },
    body: JSON.stringify({ ...report, abResults }),
  };
}

/**
 * Metering ingest (§11, #26). A scheduled job feeds per-org/period usage — email
 * volume from our counters, storageBytes + dedicatedIps from AWS metrics — and
 * we apply the cost model and persist the record for the Usage screen.
 */
export interface UsageIngestEvent {
  orgId: string;
  period: string; // "YYYY-MM"
  emailsSent: number;
  storageBytes: number;
  dedicatedIps: number;
}

export async function usageIngestHandler(event: UsageIngestEvent) {
  const record = await recordUsage(stores(), clock, event);
  return { ok: true, record };
}

/** GET per-org usage: one period, or the full history when `period` is absent. */
export async function usageHandler(event: {
  pathParameters?: { org?: string; period?: string } | null;
  orgId?: string;
  period?: string;
}) {
  const orgId = event.pathParameters?.org ?? event.orgId;
  if (!orgId) return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "org required" }) };
  const period = event.pathParameters?.period ?? event.period;
  const s = stores();
  const body = period ? await s.usage.get(orgId, period) : await s.usage.listByOrg(orgId);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "private, max-age=60" },
    body: JSON.stringify(body ?? null),
  };
}
