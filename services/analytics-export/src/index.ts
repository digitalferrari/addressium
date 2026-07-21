/**
 * addressium service: analytics-export — the Kinesis Firehose transformation
 * Lambda for the reporting read-model (docs/ARCHITECTURE.md §4.23).
 *
 * The DynamoDB table streams every change to a Kinesis data stream; Firehose
 * reads that stream and invokes this transform per batch before landing records
 * in the S3 data lake. We keep only engagement-event INSERTs, flatten each to a
 * columnar row (via the pure @addressium/domain projection), and emit it as one
 * newline-delimited JSON record for Athena. Everything else is dropped. This
 * handler holds NO AWS SDK client — Firehose delivers and persists; we only map.
 */
import { eventFromImage, toEventAnalyticsRow, type DdbAttr } from "@addressium/domain";

/** One record in a Firehose transformation invocation (data is base64). */
export interface FirehoseRecord {
  recordId: string;
  data: string;
}
export interface FirehoseTransformEvent {
  records: FirehoseRecord[];
}
export interface FirehoseResponseRecord {
  recordId: string;
  result: "Ok" | "Dropped" | "ProcessingFailed";
  data?: string;
}

/** The DynamoDB→Kinesis envelope we care about (marshalled NewImage + change kind). */
interface KinesisDdbRecord {
  eventName?: "INSERT" | "MODIFY" | "REMOVE";
  dynamodb?: { NewImage?: Record<string, DdbAttr> };
  NewImage?: Record<string, DdbAttr>;
}

const b64decode = (s: string): string => Buffer.from(s, "base64").toString("utf8");
const b64encode = (s: string): string => Buffer.from(s, "utf8").toString("base64");

export function transformRecord(record: FirehoseRecord): FirehoseResponseRecord {
  try {
    const raw = JSON.parse(b64decode(record.data)) as KinesisDdbRecord;
    // Events are append-only; only INSERTs become rows (MODIFY/REMOVE dropped).
    if (raw.eventName && raw.eventName !== "INSERT") return { recordId: record.recordId, result: "Dropped" };
    const image = raw.dynamodb?.NewImage ?? raw.NewImage;
    const event = eventFromImage(image);
    if (!event) return { recordId: record.recordId, result: "Dropped" };
    const row = toEventAnalyticsRow(event);
    // Newline-delimited JSON: Firehose extracts org_id/event_date for dynamic
    // partitioning and the JSON SerDe reads one row per line.
    return { recordId: record.recordId, result: "Ok", data: b64encode(`${JSON.stringify(row)}\n`) };
  } catch {
    return { recordId: record.recordId, result: "ProcessingFailed" };
  }
}

export async function handler(event: FirehoseTransformEvent): Promise<{ records: FirehoseResponseRecord[] }> {
  return { records: event.records.map(transformRecord) };
}

/**
 * Nightly full-table snapshot (§4.23). A scheduled EventBridge rule invokes this
 * to export the ENTIRE DynamoDB table to the S3 data lake via point-in-time
 * export — it reads from continuous backups, so it consumes NO table capacity
 * and never touches the sending path. This lands the dimension data (subscribers,
 * subscriptions, campaigns, lists) that reporting joins against; the streamed
 * event tier above keeps the fact table fresh.
 */
export async function exportHandler(): Promise<{ ok: true; exportArn: string | undefined }> {
  const { DynamoDBClient, ExportTableToPointInTimeCommand } = await import("@aws-sdk/client-dynamodb");
  const tableArn = process.env.TABLE_ARN;
  const bucket = process.env.ANALYTICS_BUCKET;
  if (!tableArn || !bucket) throw new Error("missing TABLE_ARN / ANALYTICS_BUCKET");
  const client = new DynamoDBClient({});
  const res = await client.send(
    new ExportTableToPointInTimeCommand({
      TableArn: tableArn,
      S3Bucket: bucket,
      S3Prefix: "entities/",
      ExportFormat: "DYNAMODB_JSON",
    }),
  );
  return { ok: true, exportArn: res.ExportDescription?.ExportArn };
}
