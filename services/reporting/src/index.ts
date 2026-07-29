/**
 * addressium service: reporting — hot-path campaign analytics (§4.8, §7).
 *
 * GET report for a campaign: derives HotCounters + deliverability rates from the
 * append-only event log and returns the click-overlay map. Deep, ad-hoc
 * analysis (funnels, series roll-ups) runs off the optional Firehose → S3 →
 * Athena tier, which is off by default (`enableAnalytics`); this endpoint is the
 * low-latency dashboard read and never depends on it.
 */
import { DynamoStores } from "@addressium/adapters-aws";
import { SystemClock, buildCampaignReport, meterOrgUsage, recordUsage, usagePeriodOf } from "@addressium/domain";
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
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, string> } } };
}

export async function handler(event: ReportEvent) {
  const orgId = event.pathParameters?.org ?? event.orgId;
  const campaignId = event.pathParameters?.campaign ?? event.campaignId;
  if (!orgId || !campaignId) {
    return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "org and campaign required" }) };
  }
  // Org-scoped RBAC. The route sits behind the JWT authorizer, but authentication
  // is not authorization: without this, ANY admin-pool user could read ANY org's
  // counters, rates and click map by changing the path. Mirrors usageHandler.
  try {
    authorize(grantFromClaims(event.requestContext?.authorizer?.jwt?.claims ?? {}), "reports:view", orgId);
  } catch (e) {
    const msg = (e as Error).message;
    return { statusCode: msg.startsWith("Forbidden") ? 403 : 400, headers: {}, body: JSON.stringify({ error: msg }) };
  }
  const s = stores();
  const report = await buildCampaignReport(s, orgId, campaignId);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "private, max-age=15" },
    body: JSON.stringify(report),
  };
}

/**
 * Metering ingest (§11, #26) — the AWS-side half, supplied by the operator.
 *
 * Invoke-only, deliberately: it is not behind an API route, because the numbers
 * it takes come from Cost Explorer and CloudWatch in the operator's own account,
 * not from a console user. The stack publishes its function name as the
 * `UsageIngestFunctionName` output; a metering job in that account invokes it
 * once per org per period.
 *
 * The correction that matters (#199): the previous comment here said "Athena
 * scan is attributed per org from the workgroup's query stats". It is not, and
 * it cannot be — Athena's CloudWatch metrics are dimensioned by WORKGROUP and
 * there is one workgroup per stage, so the stack has no per-org signal to
 * attribute. `athenaBytesScanned` is whatever the caller supplies; if nobody
 * supplies it, the Athena line is genuinely $0 rather than pretending to be
 * measured.
 *
 * `emailsSent` is optional here because the scheduled `usageMeterHandler` below
 * already derives it from the event log. Omit it and this call updates only the
 * AWS-side figures, leaving our own volume figure intact.
 */
export interface UsageIngestEvent {
  orgId: string;
  period: string; // "YYYY-MM"
  emailsSent?: number;
  storageBytes: number;
  dedicatedIps: number;
  /** Athena bytes scanned this period (reporting read-model, §4.23). Optional. */
  athenaBytesScanned?: number;
}

export async function usageIngestHandler(event: UsageIngestEvent) {
  const s = stores();
  const prior = event.emailsSent === undefined ? await s.usage.get(event.orgId, event.period) : undefined;
  const record = await recordUsage(s, clock, {
    ...event,
    emailsSent: event.emailsSent ?? prior?.emailsSent ?? 0,
  });
  return { ok: true, record };
}

/**
 * Scheduled metering (§11, #199) — the half this deployment can actually compute.
 *
 * The Usage screen read a permanent $0 because nothing ever wrote a usage record:
 * `usageIngestHandler` existed but was wired to nothing at all. This runs daily
 * over every org and fills in email volume from the append-only event log, then
 * merges — `meterOrgUsage` carries the operator's AWS-side figures forward
 * rather than zeroing them, so the two writers do not overwrite each other.
 *
 * Daily rather than monthly: the current period accrues, and an operator looking
 * at this month's spend on the 12th wants the first eleven days, not a blank.
 */
export async function usageMeterHandler(event?: { period?: string }) {
  const s = stores();
  const period = event?.period ?? usagePeriodOf(clock.now().toISOString());
  const orgs = await s.organizations.list();
  const metered: string[] = [];
  const failed: { orgId: string; error: string }[] = [];
  for (const org of orgs) {
    // One org's metering must not stop the rest: a partially-metered month is
    // recoverable on the next run, a run that aborts on org #3 of 40 is not.
    try {
      await meterOrgUsage(s, clock, org.orgId, period);
      metered.push(org.orgId);
    } catch (e) {
      console.error("usage-meter: org failed", { orgId: org.orgId, error: (e as Error).message });
      failed.push({ orgId: org.orgId, error: (e as Error).message });
    }
  }
  return { ok: failed.length === 0, period, metered, failed };
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
