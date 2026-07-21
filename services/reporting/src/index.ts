/**
 * addressium service: reporting — hot-path campaign analytics (§4.8, §7).
 *
 * GET report for a campaign: derives HotCounters + deliverability rates from the
 * append-only event log and returns the click-overlay map. Deep, ad-hoc
 * analysis (funnels, series roll-ups, A/B) runs off the Firehose → S3 → Athena
 * tier wired in infra; this endpoint is the low-latency dashboard read.
 */
import { DynamoStores, HttpLlmAdvisor, getSecret } from "@addressium/adapters-aws";
import { SystemClock, analyzeCampaign, buildAbReport, buildCampaignReport, recordUsage } from "@addressium/domain";
import { authorize, grantFromClaims } from "@addressium/rbac";

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
 * volume from our counters, storageBytes + dedicatedIps + athenaBytesScanned from
 * AWS metrics — and we apply the cost model and persist the record for the Usage
 * screen. Athena scan is attributed per org from the workgroup's query stats.
 */
export interface UsageIngestEvent {
  orgId: string;
  period: string; // "YYYY-MM"
  emailsSent: number;
  storageBytes: number;
  dedicatedIps: number;
  /** Athena bytes scanned this period (reporting read-model, §4.23). Optional. */
  athenaBytesScanned?: number;
}

export async function usageIngestHandler(event: UsageIngestEvent) {
  const record = await recordUsage(stores(), clock, event);
  return { ok: true, record };
}

/**
 * POST AI analysis of a campaign (§4.8, #32). Requires reports:view. Loads the
 * org's aiConfig, resolves the API key from Secrets Manager, and asks the
 * configured LLM for a performance read + suggestions over AGGREGATE analytics
 * only (no subscriber PII leaves the account).
 */
export async function analyzeHandler(event: {
  body?: string;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, string> } } };
}) {
  try {
    const { orgId, campaignId } = JSON.parse(event.body ?? "{}") as { orgId?: string; campaignId?: string };
    if (!orgId || !campaignId) return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "orgId and campaignId required" }) };
    authorize(grantFromClaims(event.requestContext?.authorizer?.jwt?.claims ?? {}), "reports:view", orgId);

    const s = stores();
    const org = await s.organizations.get(orgId);
    if (!org?.aiConfig) return { statusCode: 409, headers: {}, body: JSON.stringify({ error: "no AI provider configured for this org" }) };

    const apiKey = await getSecret(org.aiConfig.apiKeySecretArn);
    const advisor = new HttpLlmAdvisor(org.aiConfig, apiKey);
    const { analysis } = await analyzeCampaign(s, advisor, orgId, campaignId);
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vendor: analysis.vendor, model: analysis.model, analysis: analysis.text }),
    };
  } catch (e) {
    const msg = (e as Error).message;
    const forbidden = msg.startsWith("Forbidden");
    return { statusCode: forbidden ? 403 : 400, headers: {}, body: JSON.stringify({ error: msg }) };
  }
}

/** GET per-org usage: one period, or the full history when `period` is absent. */
export async function usageHandler(event: {
  pathParameters?: { org?: string; period?: string } | null;
  orgId?: string;
  period?: string;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, string> } } };
}) {
  const orgId = event.pathParameters?.org ?? event.orgId;
  if (!orgId) return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "org required" }) };
  try {
    authorize(grantFromClaims(event.requestContext?.authorizer?.jwt?.claims ?? {}), "reports:view", orgId);
  } catch (e) {
    const msg = (e as Error).message;
    return { statusCode: msg.startsWith("Forbidden") ? 403 : 400, headers: {}, body: JSON.stringify({ error: msg }) };
  }
  const period = event.pathParameters?.period ?? event.period;
  const s = stores();
  const body = period ? await s.usage.get(orgId, period) : await s.usage.listByOrg(orgId);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "private, max-age=60" },
    body: JSON.stringify(body ?? null),
  };
}
