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
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
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
import { LogGroup, LogStream, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
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
  /**
   * Registers an alarm with the stack's SNS action and its dashboard (#186).
   *
   * Passed in rather than rebuilt here: an alarm this file created privately
   * would page nobody and would not appear on the ops dashboard, which is the
   * exact failure mode this issue is about.
   */
  alarm?: (id: string, a: Alarm) => Alarm;
}

export function wireAnalytics(scope: Construct, props: AnalyticsWiringProps): void {
  const { stage, table, analyticsBucket, analyticsStream, transformFn, exportFn, alarm } = props;
  const account = Stack.of(scope).account;
  const bucket = analyticsBucket.bucketName;

  // ---- fact tier: Kinesis → Firehose (transform) → S3 ----
  const firehoseRole = new Role(scope, "AnalyticsFirehoseRole", {
    assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
  });
  analyticsBucket.grantReadWrite(firehoseRole);
  analyticsStream.grantRead(firehoseRole);
  transformFn.grantInvoke(firehoseRole);

  /**
   * Firehose's own logs (#186). The delivery stream had NO logging
   * configuration, so a delivery or transformation failure produced no CloudWatch
   * signal anywhere — the diversion to `events-errors/` was the only evidence,
   * and nothing watched that either.
   */
  const firehoseLogs = new LogGroup(scope, "AnalyticsFirehoseLogs", {
    retention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const firehoseLogStream = new LogStream(scope, "AnalyticsFirehoseLogStream", {
    logGroup: firehoseLogs,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  firehoseLogs.grantWrite(firehoseRole);

  const deliveryStream = new CfnDeliveryStream(scope, "AnalyticsFirehose", {
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
      cloudWatchLoggingOptions: {
        enabled: true,
        logGroupName: firehoseLogs.logGroupName,
        logStreamName: firehoseLogStream.logStreamName,
      },
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

  // ---- alarms on the pipeline itself (#186) ----
  //
  // The scenario these exist for: a field rename or a bundle break makes every
  // record throw, 100% of traffic diverts to `events-errors/`, and Athena keeps
  // answering from older partitions — just progressively emptier. Nobody is
  // paged; you find out weeks later when someone asks why last month is blank.
  if (alarm) {
    // Freshness is the single best signal that delivery has stopped, whatever
    // the cause: a transform failing, a permissions change, a throttle. One hour
    // is comfortably past the 5-minute buffering interval, so normal operation
    // never trips it.
    alarm(
      "AnalyticsFirehoseFreshnessAlarm",
      new Alarm(scope, "AnalyticsFirehoseFreshnessAlarm", {
        metric: new Metric({
          namespace: "AWS/Firehose",
          metricName: "DeliveryToS3.DataFreshness",
          dimensionsMap: { DeliveryStreamName: deliveryStream.ref },
          statistic: "Maximum",
          period: Duration.minutes(5),
        }),
        threshold: Duration.hours(1).toSeconds(),
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        // NOT_BREACHING, deliberately: no data means no records are flowing,
        // which for an opt-in analytics tier on a quiet deployment is normal.
        // The failure this alarm is for produces records that are LATE, not
        // absent.
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription: "addressium: analytics fact tier is not reaching S3",
      }),
    );
    // Records the transform could not process at all. Threshold 0 — any record
    // landing in the error prefix is a record missing from every report until
    // someone replays it.
    alarm(
      "AnalyticsTransformFailedAlarm",
      new Alarm(scope, "AnalyticsTransformFailedAlarm", {
        metric: new Metric({
          namespace: "AWS/Firehose",
          metricName: "ExecuteProcessingFailure.Records",
          dimensionsMap: { DeliveryStreamName: deliveryStream.ref },
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription:
          "addressium: analytics records diverted to events-errors/ — replay them (#186)",
      }),
    );
  }

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
      // Cost guardrail: a single query may scan at most 10 GB, so a missing
      // partition filter or a runaway JOIN can't quietly run up an Athena bill.
      bytesScannedCutoffPerQuery: 10 * 1024 * 1024 * 1024,
      // Publish per-query DataScannedInBytes to CloudWatch so the metering job
      // can attribute Athena spend per org (§11).
      publishCloudWatchMetricsEnabled: true,
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
