/**
 * addressium service: reporting — hot-path campaign analytics (§4.8, §7).
 *
 * GET report for a campaign: derives HotCounters + deliverability rates from the
 * append-only event log and returns the click-overlay map. Deep, ad-hoc
 * analysis (funnels, series roll-ups) runs off the optional Firehose → S3 →
 * Athena tier, which is off by default (`enableAnalytics`); this endpoint is the
 * low-latency dashboard read and never depends on it.
 */
import { DynamoStores, S3ArchiveWriter } from "@addressium/adapters-aws";
import type { EngagementEvent, HotCounters } from "@addressium/core";
import { SystemClock, buildCampaignReport, deliverabilityRates, meterOrgUsage, recordUsage, usagePeriodOf } from "@addressium/domain";
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
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, string> } } };
}

export interface TrendPoint {
  date: string;
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  bounces: number;
  complaints: number;
  openRate: number;
  clickRate: number;
}

export interface TrendSummary {
  subscriberCount: number;
  current: { emailsSent: number; openRate: number; clickRate: number };
  previous: { emailsSent: number; openRate: number; clickRate: number };
}

const TREND_TYPES = ["sent", "delivered", "open", "click", "bounce", "complaint"] as const;

/** Aggregate real event timestamps into daily, unique-engagement trend points. */
export function aggregateTrends(events: EngagementEvent[], from: string, through: string): TrendPoint[] {
  const points = new Map<string, {
    sent: number; delivered: number; bounces: number; complaints: number;
    opens: Set<string>; clicks: Set<string>;
  }>();
  for (let cursor = new Date(`${from}T00:00:00.000Z`); cursor <= new Date(`${through}T00:00:00.000Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    points.set(cursor.toISOString().slice(0, 10), { sent: 0, delivered: 0, bounces: 0, complaints: 0, opens: new Set(), clicks: new Set() });
  }
  for (const event of events) {
    if (!TREND_TYPES.includes(event.type as (typeof TREND_TYPES)[number])) continue;
    const date = event.at.slice(0, 10);
    const point = points.get(date);
    if (!point) continue;
    switch (event.type) {
      case "sent": point.sent++; break;
      case "delivered": point.delivered++; break;
      case "bounce": point.bounces++; break;
      case "complaint": point.complaints++; break;
      case "open": point.opens.add(event.subscriberId); break;
      case "click": point.clicks.add(event.subscriberId); break;
    }
  }
  return [...points].map(([date, point]) => ({
    date,
    sent: point.sent,
    delivered: point.delivered,
    opens: point.opens.size,
    clicks: point.clicks.size,
    bounces: point.bounces,
    complaints: point.complaints,
    openRate: point.sent > 0 ? point.opens.size / point.sent : 0,
    clickRate: point.sent > 0 ? point.clicks.size / point.sent : 0,
  }));
}

function summarizeWindow(events: EngagementEvent[], from: string, through: string) {
  const inWindow = events.filter((event) => {
    const day = event.at.slice(0, 10);
    return day >= from && day <= through;
  });
  const sent = inWindow.filter((event) => event.type === "sent").length;
  const opens = new Set(inWindow.filter((event) => event.type === "open").map((event) => event.subscriberId)).size;
  const clicks = new Set(inWindow.filter((event) => event.type === "click").map((event) => event.subscriberId)).size;
  return {
    emailsSent: sent,
    openRate: sent > 0 ? opens / sent : 0,
    clickRate: sent > 0 ? clicks / sent : 0,
  };
}

/** GET daily event trends for the selected org. The event log is the source of truth. */
export async function trendsHandler(event: ReportEvent) {
  const orgId = event.pathParameters?.org ?? event.orgId;
  if (!orgId) return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "org required" }) };
  try {
    authorize(grantFromClaims(event.requestContext?.authorizer?.jwt?.claims ?? {}), "reports:view", orgId);
  } catch (e) {
    const msg = (e as Error).message;
    return { statusCode: msg.startsWith("Forbidden") ? 403 : 400, headers: {}, body: JSON.stringify({ error: msg }) };
  }
  const rawDays = Number(event.queryStringParameters?.days ?? "30");
  const days = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 90 ? rawDays : 30;
  const through = clock.now().toISOString().slice(0, 10);
  const fromDate = new Date(`${through}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - days + 1);
  const from = fromDate.toISOString().slice(0, 10);
  const previousThroughDate = new Date(`${from}T00:00:00.000Z`);
  previousThroughDate.setUTCDate(previousThroughDate.getUTCDate() - 1);
  const previousThrough = previousThroughDate.toISOString().slice(0, 10);
  const previousFromDate = new Date(`${previousThrough}T00:00:00.000Z`);
  previousFromDate.setUTCDate(previousFromDate.getUTCDate() - days + 1);
  const previousFrom = previousFromDate.toISOString().slice(0, 10);
  // Both reads in PARALLEL, and each campaign's events in parallel with the
  // others (#294). This was a sequential `for` loop doing one round trip per
  // campaign, then a full subscriber scan — on an admin screen that is the
  // first thing loaded after login, so every hop was felt.
  /**
   * Read the WINDOW, not every campaign ever (#320).
   *
   * `betweenDates` queries a time-ordered index sharded by org-month, so a
   * 30-day chart is one or two reads. The previous path fanned out one read per
   * campaign — 32 on dev, ~2,500 after a year of seven daily publications —
   * because events are partitioned per campaign on the base table.
   *
   * `previousFrom` is the lower bound, not `from`: the summary compares the
   * window against the one before it, so both must be fetched.
   *
   * The per-campaign fan-out remains as a FALLBACK for a store without the
   * index, and for events written before it existed — those carry no `gsi4pk`
   * and are invisible to the query. A reporting screen that silently
   * under-reports is worse than one that is slow, so the fallback is a real
   * path rather than a courtesy.
   */
  const [events, subscriberCount] = await Promise.all([
    (async (): Promise<EngagementEvent[]> => {
      const windowed = await stores().events.betweenDates?.(orgId, previousFrom, through);
      if (windowed) return windowed;
      const campaigns = await stores().campaigns.list(orgId);
      return (
        await Promise.all(campaigns.map((c) => stores().events.all(orgId, c.campaignId)))
      ).flat();
    })(),
    // Counted server-side. This used to consume `stream()` purely to increment
    // a number: every subscriber marshalled out of DynamoDB, across the network
    // and deserialized, only to be discarded.
    stores().subscribers.count(orgId),
  ]);
  const summary: TrendSummary = {
    subscriberCount,
    current: summarizeWindow(events, from, through),
    previous: summarizeWindow(events, previousFrom, previousThrough),
  };
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "private, max-age=60" },
    body: JSON.stringify({ orgId, from, through, days, points: aggregateTrends(events, from, through), summary }),
  };
}

export interface SeriesReportEvent extends ReportEvent {
  pathParameters?: { org?: string; campaign?: string; series?: string } | null;
  seriesId?: string;
}

function addCounters(total: HotCounters, next: HotCounters): HotCounters {
  return {
    sent: total.sent + next.sent,
    delivered: total.delivered + next.delivered,
    opens: total.opens + next.opens,
    clicks: total.clicks + next.clicks,
    bounces: total.bounces + next.bounces,
    complaints: total.complaints + next.complaints,
    unsubscribes: total.unsubscribes + next.unsubscribes,
    rejects: total.rejects + next.rejects,
    renderingFailures: total.renderingFailures + next.renderingFailures,
    deliveryDelays: total.deliveryDelays + next.deliveryDelays,
  };
}

/** Aggregate the durable edition rows belonging to a recurring series. */
export async function seriesReportHandler(event: SeriesReportEvent) {
  const orgId = event.pathParameters?.org;
  const seriesId = event.pathParameters?.series ?? event.seriesId;
  if (!orgId || !seriesId) {
    return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "org and series required" }) };
  }
  try {
    authorize(grantFromClaims(event.requestContext?.authorizer?.jwt?.claims ?? {}), "reports:view", orgId);
  } catch (e) {
    const msg = (e as Error).message;
    return { statusCode: msg.startsWith("Forbidden") ? 403 : 400, headers: {}, body: JSON.stringify({ error: msg }) };
  }
  const editions = (await stores().campaigns.list(orgId))
    .filter((campaign) => campaign.type === "series_edition" && campaign.seriesId === seriesId && campaign.campaignId !== seriesId)
    .sort((a, b) => b.campaignId.localeCompare(a.campaignId));
  let aggregate: HotCounters = {
    sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0,
    unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0,
  };
  for (const edition of editions) aggregate = addCounters(aggregate, edition.counters);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "private, max-age=15" },
    body: JSON.stringify({
      orgId,
      seriesId,
      editions: editions.map((edition) => ({ campaignId: edition.campaignId, subject: edition.subject, status: edition.status, counters: edition.counters })),
      aggregate,
      rates: deliverabilityRates(aggregate),
    }),
  };
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

function decorateArchive(html: string, rows: Array<{ linkId: string; clicks: number; unique: number }>): string {
  const counts = new Map(rows.map((row) => [row.linkId, row]));
  const decorated = html.replace(
    /(<a\b[^>]*data-linkid=["'](l\d+)["'][^>]*>[\s\S]*?<\/a>)/gi,
    (whole, _unused, linkId: string) => {
      const row = counts.get(linkId);
      if (!row) return whole;
      return `${whole}<span class="addressium-click-badge">${row.clicks} clicks · ${row.unique} unique</span>`;
    },
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 20px;color:#18212f;line-height:1.5}
    .addressium-click-badge{display:inline-block;margin:0 0 0 8px;padding:2px 7px;border-radius:999px;background:#e5efff;color:#2457a6;font:12px system-ui,sans-serif;vertical-align:middle}
  </style></head><body>${decorated}</body></html>`;
}

/** Authenticated preview of the generic campaign body with click counts attached. */
export async function archiveHandler(event: ReportEvent) {
  const orgId = event.pathParameters?.org ?? event.orgId;
  const campaignId = event.pathParameters?.campaign ?? event.campaignId;
  if (!orgId || !campaignId) {
    return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "org and campaign required" }) };
  }
  try {
    authorize(grantFromClaims(event.requestContext?.authorizer?.jwt?.claims ?? {}), "reports:view", orgId);
  } catch (e) {
    const msg = (e as Error).message;
    return { statusCode: msg.startsWith("Forbidden") ? 403 : 400, headers: {}, body: JSON.stringify({ error: msg }) };
  }
  const bucket = process.env.ARCHIVE_BUCKET;
  if (!bucket) return { statusCode: 503, headers: {}, body: JSON.stringify({ error: "archive preview unavailable" }) };
  const s = stores();
  const archive = await s.archive.get(orgId, campaignId);
  if (!archive) return { statusCode: 404, headers: {}, body: JSON.stringify({ error: "campaign archive not found" }) };
  const html = await new S3ArchiveWriter(bucket).get(archive.s3Key);
  if (html === undefined) return { statusCode: 404, headers: {}, body: JSON.stringify({ error: "campaign body not found" }) };
  const report = await buildCampaignReport(s, orgId, campaignId);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "private, max-age=15" },
    body: JSON.stringify({ html: decorateArchive(html, report.clickMap.rows) }),
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
