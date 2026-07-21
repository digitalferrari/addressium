/**
 * Reporting read-model wiring (docs/ARCHITECTURE.md §4.23).
 *
 * Opt-in (context `enableAnalytics`). Projects the hot DynamoDB table into a
 * separate S3 data lake queried by Athena, so cross-campaign cohort reporting
 * runs off columnar SQL and never touches the sending path:
 *
 *   - FACTS: DynamoDB → Kinesis stream → Firehose → (transform Lambda filters to
 *     engagement events + flattens) → S3 `events/org_id=…/event_date=…/` (NDJSON,
 *     dynamically partitioned), catalogued as a Glue table with partition
 *     projection so no crawler is needed.
 *   - DIMENSIONS: a nightly point-in-time export drops the WHOLE table to
 *     S3 `entities/` with zero read-capacity cost.
 *   - QUERY: an Athena workgroup with its own results prefix.
 *
 * The Kinesis stream and the two Lambdas are created by the stack (they need its
 * bundler + base env); this helper wires Firehose, Glue, Athena and the export
 * schedule around them.
 */
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IStream } from "aws-cdk-lib/aws-kinesis";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";

export interface AnalyticsWiringProps {
  stage: string;
  table: Table;
  analyticsBucket: Bucket;
  analyticsStream: IStream;
  /** Firehose data-transformation Lambda (services/analytics-export `handler`). */
  transformFn: IFunction;
  /** Nightly full-table export Lambda (services/analytics-export `exportHandler`). */
  exportFn: IFunction;
}

export function wireAnalytics(scope: Construct, props: AnalyticsWiringProps): void {
  const { stage, table, analyticsBucket, analyticsStream, transformFn, exportFn } = props;
  const account = Stack.of(scope).account;
  const bucket = analyticsBucket.bucketName;

  // ---- fact tier: Kinesis → Firehose (transform) → S3 ----
  const firehoseRole = new Role(scope, "AnalyticsFirehoseRole", {
    assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
  });
  analyticsBucket.grantReadWrite(firehoseRole);
  analyticsStream.grantRead(firehoseRole);
  transformFn.grantInvoke(firehoseRole);

  new CfnDeliveryStream(scope, "AnalyticsFirehose", {
    deliveryStreamType: "KinesisStreamAsSource",
    kinesisStreamSourceConfiguration: {
      kinesisStreamArn: analyticsStream.streamArn,
      roleArn: firehoseRole.roleArn,
    },
    extendedS3DestinationConfiguration: {
      bucketArn: analyticsBucket.bucketArn,
      roleArn: firehoseRole.roleArn,
      // Partition columns are pulled from the transformed record (below), so the
      // fact table self-organizes by org and day for cheap tenant/date pruning.
      prefix: "events/org_id=!{partitionKeyFromQuery:org_id}/event_date=!{partitionKeyFromQuery:event_date}/",
      errorOutputPrefix: "events-errors/!{firehose:error-output-type}/",
      // Dynamic partitioning requires ≥64 MB buffering.
      bufferingHints: { intervalInSeconds: 300, sizeInMBs: 64 },
      compressionFormat: "GZIP",
      dynamicPartitioningConfiguration: { enabled: true },
      processingConfiguration: {
        enabled: true,
        processors: [
          {
            type: "Lambda",
            parameters: [{ parameterName: "LambdaArn", parameterValue: transformFn.functionArn }],
          },
          {
            type: "MetadataExtraction",
            parameters: [
              { parameterName: "MetadataExtractionQuery", parameterValue: "{org_id:.org_id,event_date:.event_date}" },
              { parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" },
            ],
          },
        ],
      },
    },
  });

  // ---- catalog: Glue database + events table (partition projection, no crawler) ----
  const dbName = `addressium_${stage}`;
  const db = new CfnDatabase(scope, "AnalyticsGlueDb", {
    catalogId: account,
    databaseInput: { name: dbName },
  });
  const eventsTable = new CfnTable(scope, "AnalyticsEventsTable", {
    catalogId: account,
    databaseName: dbName,
    tableInput: {
      name: "events",
      tableType: "EXTERNAL_TABLE",
      partitionKeys: [
        { name: "org_id", type: "string" },
        { name: "event_date", type: "string" },
      ],
      parameters: {
        classification: "json",
        "projection.enabled": "true",
        "projection.org_id.type": "injected",
        "projection.event_date.type": "date",
        "projection.event_date.range": "2024-01-01,NOW",
        "projection.event_date.format": "yyyy-MM-dd",
        "projection.event_date.interval": "1",
        "projection.event_date.interval.unit": "DAYS",
        "storage.location.template": `s3://${bucket}/events/org_id=\${org_id}/event_date=\${event_date}/`,
      },
      storageDescriptor: {
        location: `s3://${bucket}/events/`,
        inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
        outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
        serdeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
        // org_id / event_date are partition keys, so they are NOT repeated here.
        columns: [
          { name: "campaign_id", type: "string" },
          { name: "subscriber_id", type: "string" },
          { name: "event_type", type: "string" },
          { name: "link_id", type: "string" },
          { name: "at", type: "string" },
        ],
      },
    },
  });
  eventsTable.addDependency(db);

  // ---- query: an Athena workgroup with its own results prefix ----
  new CfnWorkGroup(scope, "AnalyticsWorkgroup", {
    name: `addressium-${stage}`,
    workGroupConfiguration: {
      resultConfiguration: { outputLocation: `s3://${bucket}/athena-results/` },
    },
  });

  // ---- dimension tier: nightly full-table point-in-time export → S3 ----
  table.grant(exportFn, "dynamodb:ExportTableToPointInTime");
  analyticsBucket.grantWrite(exportFn);
  new Rule(scope, "AnalyticsExportSchedule", {
    // 03:00 UTC daily — off-peak; the export reads continuous backups, not the table.
    schedule: Schedule.cron({ minute: "0", hour: "3" }),
    targets: [new LambdaFunction(exportFn)],
  });
}
