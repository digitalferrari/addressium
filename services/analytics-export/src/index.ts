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
import {
  erasureFromImage,
  eventFromImage,
  toErasureAnalyticsRow,
  toEventAnalyticsRow,
  type DdbAttr,
} from "@addressium/domain";

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
    // A GDPR erasure tombstone lands in the same table as an `erased` row (#164),
    // so every query can anti-join against it. Rows already written to S3 cannot
    // be deleted per subject — they are compressed, partitioned, append-only
    // objects — and a second Firehose plus a second Glue table would be one more
    // thing an operator's query could forget to include.
    const erasure = erasureFromImage(image);
    const row = erasure ? toErasureAnalyticsRow(erasure) : null;
    if (!row) {
      const event = eventFromImage(image);
      if (!event) return { recordId: record.recordId, result: "Dropped" };
      return {
        recordId: record.recordId,
        result: "Ok",
        data: b64encode(`${JSON.stringify(toEventAnalyticsRow(event))}\n`),
      };
    }
    // Newline-delimited JSON: Firehose extracts org_id/event_date for dynamic
    // partitioning and the JSON SerDe reads one row per line.
    return { recordId: record.recordId, result: "Ok", data: b64encode(`${JSON.stringify(row)}\n`) };
  } catch (e) {
    // BOUND and logged (#186). The error was discarded without being bound, so a
    // transform failing on every record produced zero signal — not in this
    // Lambda's own log group, not anywhere. The recordId is what makes the log
    // line actionable: it is the handle Firehose parks the record under in
    // `events-errors/`, so it connects the log to the object to replay.
    //
    // `ProcessingFailed` is FINAL — Firehose does not retry it — so this is the
    // only record that this datum ever existed. It deserves to be loud.
    console.error("analytics-export: transform failed", {
      recordId: record.recordId,
      error: (e as Error).message,
      stack: (e as Error).stack,
    });
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
export async function exportHandler(): Promise<{ ok: true; exportArn: string | undefined; prefix: string }> {
  const { DynamoDBClient, ExportTableToPointInTimeCommand } = await import("@aws-sdk/client-dynamodb");
  const { entitiesExportPrefix } = await import("@addressium/domain");
  const tableArn = process.env.TABLE_ARN;
  const bucket = process.env.ANALYTICS_BUCKET;
  if (!tableArn || !bucket) throw new Error("missing TABLE_ARN / ANALYTICS_BUCKET");
  const client = new DynamoDBClient({});
  // Partitioned by export day (#199). A flat `entities/` prefix piled 30 retained
  // snapshots into one location, so nothing could query a single consistent one.
  const prefix = entitiesExportPrefix(new Date());
  const res = await client.send(
    new ExportTableToPointInTimeCommand({
      TableArn: tableArn,
      S3Bucket: bucket,
      S3Prefix: prefix,
      ExportFormat: "DYNAMODB_JSON",
    }),
  );
  return { ok: true, exportArn: res.ExportDescription?.ExportArn, prefix };
}

/**
 * Replay records Firehose parked under `events-errors/` (#186).
 *
 * Nothing reprocessed that prefix, so a transform bug was permanent data loss
 * wearing the costume of a temporary diversion: Athena kept answering from older
 * partitions, just progressively emptier, and the gap only surfaced when
 * somebody asked why last month was blank.
 *
 * Invoked on demand rather than on a schedule. A replay is a response to a
 * known, fixed defect — running it automatically would re-run the same broken
 * transform against the same records and file them straight back, turning one
 * incident into a loop.
 *
 * Idempotent by construction: the written key is derived from the SOURCE
 * object's name, so replaying the same file twice overwrites rather than
 * duplicating. On an append-only lake that distinction is the difference between
 * a fix and a second incident. The source object is deleted only after its rows
 * are safely written.
 */
export async function replayHandler(event?: { prefix?: string; dryRun?: boolean }): Promise<{
  objectsScanned: number;
  recordsParsed: number;
  rowsWritten: number;
  objectsReplayed: number;
  failed: { key: string; error: string }[];
}> {
  const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } =
    await import("@aws-sdk/client-s3");
  const { parseFirehoseErrorOutput, planReplayWrites } = await import("@addressium/domain");
  const bucket = process.env.ANALYTICS_BUCKET;
  if (!bucket) throw new Error("missing ANALYTICS_BUCKET");
  const s3 = new S3Client({});
  const prefix = event?.prefix ?? "events-errors/";

  let objectsScanned = 0;
  let recordsParsed = 0;
  let rowsWritten = 0;
  let objectsReplayed = 0;
  const failed: { key: string; error: string }[] = [];

  let ContinuationToken: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }),
    );
    for (const obj of listed.Contents ?? []) {
      const key = obj.Key;
      if (!key || key.endsWith("/")) continue;
      objectsScanned++;
      try {
        const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await got.Body!.transformToString();
        const records = parseFirehoseErrorOutput(body);
        recordsParsed += records.length;

        // Re-run the SAME transform. If it still throws, the defect is not fixed
        // and the record stays parked — replaying it into the lake unprocessed
        // would put the corruption in the reporting tier instead of beside it.
        const rows = records
          .map((r) => transformRecord({ recordId: key, data: Buffer.from(r.rawData, "utf8").toString("base64") }))
          .filter((r) => r.result === "Ok" && r.data)
          .map((r) => JSON.parse(Buffer.from(r.data!, "base64").toString("utf8")) as Record<string, string>);

        if (rows.length === 0) {
          // Nothing recoverable from this file yet. Left in place deliberately:
          // deleting it would discard the evidence AND the data.
          continue;
        }
        const suffix = key.replace(/[^a-zA-Z0-9]+/g, "-").slice(-120);
        const writes = planReplayWrites(rows as never, suffix);
        if (event?.dryRun) {
          rowsWritten += rows.length;
          continue;
        }
        for (const w of writes) {
          await s3.send(new PutObjectCommand({ Bucket: bucket, Key: w.key, Body: w.body }));
        }
        rowsWritten += rows.length;
        // Only now — a delete before the write is how a recovery becomes a loss.
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        objectsReplayed++;
      } catch (e) {
        // One bad object must not stop the batch: this runs during an incident,
        // and recovering most of the data beats recovering none of it.
        console.error("analytics-export: replay failed", { key, error: (e as Error).message });
        failed.push({ key, error: (e as Error).message });
      }
    }
    ContinuationToken = listed.NextContinuationToken;
  } while (ContinuationToken);

  console.log("analytics-export: replay complete", {
    objectsScanned, recordsParsed, rowsWritten, objectsReplayed, failed: failed.length,
  });
  return { objectsScanned, recordsParsed, rowsWritten, objectsReplayed, failed };
}
