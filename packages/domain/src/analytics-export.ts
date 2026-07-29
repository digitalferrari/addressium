/**
 * Analytics export projection (docs/ARCHITECTURE.md §4.23).
 *
 * Reporting is a separate read-model (CQRS): the hot DynamoDB table streams its
 * engagement events to a data lake (S3), catalogued in Glue and queried with
 * Athena, so cross-campaign cohort questions ("how many opened ≥K of the last N
 * editions", funnels, retention) run off columnar SQL instead of hammering the
 * sending path. This module holds the PURE projection logic — flattening an
 * engagement event to a columnar row and pulling one out of a raw DynamoDB
 * stream image — so it is unit-tested without any AWS wiring. The Firehose
 * transformation Lambda (services/analytics-export) is a thin shell over it.
 */
import type { EngagementEvent, ErasureRecord, EventType } from "@addressium/core";

/**
 * The `event_type` values the lake carries.
 *
 * `erased` is not an engagement event — it is the GDPR tombstone (#164), landed
 * in the SAME table on purpose. Rows already written to S3 cannot be deleted per
 * subject (compressed, partitioned, append-only objects), so every query
 * anti-joins against these rows instead. Putting them in the existing table
 * means no second Firehose, no second Glue table, and no partition an operator
 * can forget to include in a query.
 */
export type LakeEventType = EventType | "erased";

/** A flattened, columnar-friendly analytics row for one engagement event. */
export interface EventAnalyticsRow {
  org_id: string;
  campaign_id: string;
  subscriber_id: string;
  event_type: LakeEventType;
  /** Resolved link id for clicks; null otherwise (tokens are never exported). */
  link_id: string | null;
  at: string;
  /** UTC calendar day — the S3 / Glue partition key (`event_date=YYYY-MM-DD`). */
  event_date: string;
}

/** The S3/Glue partition day for an ISO-8601 `Z` timestamp (storage is UTC, §4.21). */
export function eventPartitionDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Flatten an engagement event into its analytics row. */
export function toEventAnalyticsRow(e: EngagementEvent): EventAnalyticsRow {
  return {
    org_id: e.orgId,
    campaign_id: e.campaignId,
    subscriber_id: e.subscriberId,
    event_type: e.type,
    link_id: e.linkId ?? null,
    at: e.at,
    event_date: eventPartitionDate(e.at),
  };
}

/** A marshalled DynamoDB attribute value — only the shapes we read from event items. */
export interface DdbAttr {
  S?: string;
  N?: string;
  M?: Record<string, DdbAttr>;
  NULL?: boolean;
}

/**
 * Pull the `EngagementEvent` out of a DynamoDB stream/Kinesis `NewImage`, or
 * null when the item is not an engagement event (its `sk` isn't `EVENT#…`) or is
 * incomplete. Every event field is a string, so this reads only `S` — no
 * `@aws-sdk/util-dynamodb` needed, keeping the transform Lambda dependency-free.
 */
export function eventFromImage(image: Record<string, DdbAttr> | undefined): EngagementEvent | null {
  if (!image) return null;
  const sk = image.sk?.S;
  if (!sk || !sk.startsWith("EVENT#")) return null;
  const d = image.data?.M;
  if (!d) return null;
  const orgId = d.orgId?.S;
  const campaignId = d.campaignId?.S;
  const subscriberId = d.subscriberId?.S;
  const type = d.type?.S as EventType | undefined;
  const at = d.at?.S;
  if (!orgId || !campaignId || !subscriberId || !type || !at) return null;
  const linkId = d.linkId?.S;
  return { orgId, campaignId, subscriberId, type, at, ...(linkId ? { linkId } : {}) };
}

/**
 * The S3 prefix one nightly dimension export writes to (#199).
 *
 * Partitioned by export day, because the exports are RETAINED — the bucket keeps
 * 30 of them. A flat `entities/` prefix meant a Glue table over it would union
 * every snapshot into 30 duplicate copies of every row, with no predicate that
 * could say "the most recent one". `export_date=YYYY-MM-DD` makes one snapshot
 * addressable, which is the difference between a queryable dimension tier and
 * paying to store one.
 *
 * DynamoDB nests `AWSDynamoDB/<export-id>/` beneath whatever prefix it is given,
 * so two exports on the same day coexist rather than overwriting; a query
 * wanting exactly one snapshot filters on the export id in the object key.
 */
export function entitiesExportPrefix(now: Date): string {
  return `entities/export_date=${now.toISOString().slice(0, 10)}/`;
}

/**
 * Flatten an erasure tombstone into a lake row (#164).
 *
 * `campaign_id` is empty rather than null: it is a partition-adjacent column the
 * Glue SerDe reads as a string, and an anti-join keyed on `subscriber_id` never
 * looks at it. It carries no personal data — a random UUID whose link to a
 * person was destroyed by the erasure that produced this row.
 */
export function toErasureAnalyticsRow(e: ErasureRecord): EventAnalyticsRow {
  return {
    org_id: e.orgId,
    campaign_id: "",
    subscriber_id: e.subscriberId,
    event_type: "erased",
    link_id: null,
    at: e.erasedAt,
    event_date: eventPartitionDate(e.erasedAt),
  };
}

/**
 * Pull an `ErasureRecord` out of a stream image, or null when the item is not
 * one (#164).
 *
 * A DELETE arrives with no NewImage, so only writes produce a row — which is
 * what we want: the tombstone is written once and never removed.
 */
export function erasureFromImage(image: Record<string, DdbAttr> | undefined): ErasureRecord | null {
  if (!image) return null;
  const sk = image.sk?.S;
  if (!sk || !sk.startsWith("ERASURE#")) return null;
  const d = image.data?.M;
  if (!d) return null;
  const orgId = d.orgId?.S;
  const subscriberId = d.subscriberId?.S;
  const erasedAt = d.erasedAt?.S;
  if (!orgId || !subscriberId || !erasedAt) return null;
  return { orgId, subscriberId, erasedAt };
}

/**
 * One record Firehose parked under `events-errors/` (#186).
 *
 * Firehose writes its error output as newline-delimited JSON, one object per
 * failed record, with the ORIGINAL payload base64-encoded in `rawData`. That is
 * what makes replay possible at all: the datum is not lost, it is filed
 * somewhere nothing reads.
 */
export interface FirehoseErrorRecord {
  /** The original record, base64-decoded. */
  rawData: string;
  errorCode?: string;
  errorMessage?: string;
  attemptsMade?: number;
}

/**
 * Parse a Firehose error-output object into its records (#186).
 *
 * Tolerant by design: a malformed line is SKIPPED rather than aborting the
 * batch. An error-output file is by definition written during an incident, and
 * refusing to replay ninety-nine good records because the hundredth is truncated
 * is the wrong trade — the whole point of this path is to recover what can be
 * recovered.
 */
export function parseFirehoseErrorOutput(body: string): FirehoseErrorRecord[] {
  const out: FirehoseErrorRecord[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { rawData?: unknown; errorCode?: unknown; errorMessage?: unknown; attemptsMade?: unknown };
      if (typeof parsed.rawData !== "string") continue;
      out.push({
        rawData: Buffer.from(parsed.rawData, "base64").toString("utf8"),
        ...(typeof parsed.errorCode === "string" ? { errorCode: parsed.errorCode } : {}),
        ...(typeof parsed.errorMessage === "string" ? { errorMessage: parsed.errorMessage } : {}),
        ...(typeof parsed.attemptsMade === "number" ? { attemptsMade: parsed.attemptsMade } : {}),
      });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The S3 prefix a lake row belongs to — the same partitioning Firehose applies
 * (#186), so a replayed row lands where a live one would and Athena's partition
 * projection finds it without any catalog change.
 */
export function lakePartitionPrefix(row: EventAnalyticsRow): string {
  return `events/org_id=${row.org_id}/event_date=${row.event_date}/`;
}

/**
 * Group rows into the objects a replay should write (#186).
 *
 * Pure, so the partitioning is unit-tested rather than discovered against a live
 * bucket during an incident — which is the only time this code runs.
 */
export function planReplayWrites(
  rows: EventAnalyticsRow[],
  suffix: string,
): { key: string; body: string }[] {
  const byPrefix = new Map<string, EventAnalyticsRow[]>();
  for (const row of rows) {
    const prefix = lakePartitionPrefix(row);
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(row);
    else byPrefix.set(prefix, [row]);
  }
  return [...byPrefix.entries()].map(([prefix, group]) => ({
    // Named for the source object, so a replay is traceable back to the error
    // file it recovered — and so replaying the same file twice overwrites rather
    // than duplicating, which on an append-only lake is the difference between
    // a fix and a second incident.
    key: `${prefix}replay-${suffix}.json`,
    body: group.map((r) => JSON.stringify(r)).join("\n") + "\n",
  }));
}
