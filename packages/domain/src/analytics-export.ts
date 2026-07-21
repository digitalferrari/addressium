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
import type { EngagementEvent, EventType } from "@addressium/core";

/** A flattened, columnar-friendly analytics row for one engagement event. */
export interface EventAnalyticsRow {
  org_id: string;
  campaign_id: string;
  subscriber_id: string;
  event_type: EventType;
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
