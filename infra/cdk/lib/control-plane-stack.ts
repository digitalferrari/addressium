/**
 * Shared control-plane stack (docs/ARCHITECTURE.md §3, §9).
 *
 * One per deployment. Declares the resources shared across all organizations —
 * the single DynamoDB table (partitioned by orgId, + gsi1 email / gsi2
 * subscriber), the admin Cognito pool (with seeded first admin), S3 buckets, the
 * SQS send queue, the SES-events SNS topic — and wires the service handlers to
 * an HTTP API, the queue, and the topic. Per-org resources (subscriber pool,
 * KMS signing key, SES identity, config set, JWKS) are provisioned at runtime
 * (§4.11).
 *
 * Bundling uses NodejsFunction (esbuild) — run `npm install` (and have esbuild
 * available) before `cdk synth`. Secrets are passed by ARN, not value, so no
 * plaintext secret lands in the template; handlers resolve them at cold start.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput, Lazy, ArnFormat, CustomResource } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AttributeType, BillingMode, StreamViewType, Table, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { Key } from "aws-cdk-lib/aws-kms";
import { Bucket, BlockPublicAccess, ObjectLockRetention, StorageClass, HttpMethods } from "aws-cdk-lib/aws-s3";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import {
  Mfa,
  UserPool,
  UserPoolClient,
  UserPoolEmail,
  CfnUserPoolUser,
  StringAttribute,
  OAuthScope,
  ClientAttributes,
  AccountRecovery,
} from "aws-cdk-lib/aws-cognito";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource, DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { StartingPosition } from "aws-cdk-lib/aws-lambda";
import { CfnCollection, CfnSecurityPolicy, CfnAccessPolicy } from "aws-cdk-lib/aws-opensearchserverless";
import { HttpApi, HttpMethod, CorsHttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription, SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import {
  Alarm,
  AlarmStatusWidget,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { FilterPattern, LogGroup, MetricFilter, RetentionDays } from "aws-cdk-lib/aws-logs";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import {
  BackupPlan,
  BackupPlanRule,
  BackupResource,
  BackupVault,
} from "aws-cdk-lib/aws-backup";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Role, ServicePrincipal, PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
import { CfnScheduleGroup } from "aws-cdk-lib/aws-scheduler";
import {
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  JsonPath,
  StateMachine,
  Succeed,
  TaskInput,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { CfnWebACLAssociation } from "aws-cdk-lib/aws-wafv2";
import { Stream, StreamMode } from "aws-cdk-lib/aws-kinesis";
import { Provider } from "aws-cdk-lib/custom-resources";
import { APP_VERSION, EXPECTED_SCHEMA_VERSION } from "@addressium/core";
import { StaticSite } from "./static-site.js";
import { wireAnalytics } from "./analytics.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const svc = (rel: string) => resolve(REPO_ROOT, rel);

/**
 * The deployment stages addressium recognises (#190).
 *
 * A closed set, not a free-form string, because `stage === "prod"` is what
 * decides log retention, termination protection and — historically — every
 * removal policy in the stack. `"production"` or `"Prod"` compared unequal and
 * silently produced a NON-prod stack holding production data.
 */
export const STAGES = ["dev", "staging", "prod"] as const;
export type Stage = (typeof STAGES)[number];

/** Narrow an untrusted string to a `Stage`, or throw with the valid set. */
export function parseStage(value: string): Stage {
  if ((STAGES as readonly string[]).includes(value)) return value as Stage;
  throw new Error(
    `invalid stage ${JSON.stringify(value)} — must be one of ${STAGES.join(", ")}. ` +
      `Stage decides termination protection and log retention, so a typo here is a ` +
      `production deployment configured as a scratch one.`,
  );
}

export interface ControlPlaneStackProps extends StackProps {
  /**
   * Validated at construction (#190). Typed as a string rather than `Stage` so
   * the error an operator sees is the message above, naming the valid values —
   * a TypeScript error in a config file they never compile helps nobody.
   */
  stage: string;
  adminEmails: string[];
  adminHostedUiDomainPrefix: string;
  /**
   * Public URL of the admin console, used for the Cognito callback/logout URLs
   * and API CORS. Defaults to this stack's own CloudFront distribution; set it
   * when the console is served from a custom domain.
   */
  adminAppUrl?: string;
  /** Public URL of the subscriber/public site. Defaults to its distribution. */
  publicAppUrl?: string;
  /** Staged custom hostname for the admin SPA; DNS is managed outside AWS. */
  adminCustomDomain?: { domainName: string };
  /** Staged custom hostname for the public/subscriber SPA; DNS is managed outside AWS. */
  publicCustomDomain?: { domainName: string };
  /**
   * Public origin of the HTTP API, used as the `connect-src` entry in the SPAs'
   * CSP (#197). It cannot default to `api.apiEndpoint`: the API's CORS allowlist
   * already points at the two distributions, so naming the API from a
   * distribution closes a CloudFormation dependency cycle and synth fails.
   * Absent, the CSP falls back to `https://*.execute-api.<region>.amazonaws.com`
   * — bounded to API Gateway in this region, but not to THIS api. Set it (with
   * a custom domain, or the endpoint from a first deploy) to tighten that.
   */
  apiAppUrl?: string;
  /**
   * An SNS topic the OPERATOR owns, for infrastructure alarms (#222, compendium
   * #22/#32/#67). When set, no topic is created here and no ARN is exported —
   * alert routing is account-wide plumbing addressium does not take over.
   */
  opsAlertTopicArn?: string;
  /** Create a topic and subscribe this address. Ignored when the ARN is set. */
  opsAlertEmail?: string;
  /**
   * FROM address for admin invites and password resets, sent through SES.
   * Its domain must already be a VERIFIED SES identity. Absent means Cognito's
   * own sender — see `adminFromEmail` in bin/addressium.ts for why that default
   * is a poor one for the emails that gate console access.
   */
  adminFromEmail?: string;
  /**
   * A REGIONAL WebACL the operator owns, associated with the HTTP API stage
   * (#225). Absent means no association — the stack never creates one.
   */
  apiWebAclArn?: string;
  /**
   * A CLOUDFRONT-scope WebACL (must live in us-east-1), attached to both SPA
   * distributions. Absent means no association.
   */
  cloudfrontWebAclArn?: string;
}

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    // Validated BEFORE `super`, so an unrecognised stage fails at synth rather
    // than after a stack has been constructed around it (#190). The result also
    // decides termination protection, which is a StackProps field and so has to
    // be known here.
    super(scope, id, {
      ...props,
      // A prod stack refuses `cdk destroy` outright. The removal policies below
      // already RETAIN the data, but a destroyed stack still tears down the API,
      // the queues and the schedules — an outage rather than a data loss, and
      // still not something anyone should be able to do by running the wrong
      // command in the wrong terminal. An explicit
      // `aws cloudformation update-termination-protection` turns it off.
      terminationProtection: props.terminationProtection ?? parseStage(props.stage) === "prod",
    });

    // ---- data plane ----
    // OpenSearch segmentation mirror is opt-in (standing cost, #28). When on,
    // the table streams changes to the indexer that mirrors to OpenSearch.
    const mirrorCtx = this.node.tryGetContext("enableOpenSearchMirror") as boolean | string | undefined;
    const enableOpenSearchMirror = mirrorCtx === true || mirrorCtx === "true";

    // Reporting read-model (§4.23) is opt-in — when on, the table fans its change
    // stream out to Kinesis for the analytics data lake (separate from the
    // DynamoDB Streams the OpenSearch mirror uses).
    // Fail at SYNTH on an unrecognised stage (#190). Every data-protection
    // decision below keys off this value, and a mistyped one used to produce a
    // stack that looked deployed-to-prod and behaved like a scratch environment.
    const stage = parseStage(props.stage);
    // The custom-domain objects own certificate validation and alias records.
    // Preserve the explicit URL fields for an externally-managed domain, but a
    // managed domain is its own source of truth for Cognito/CORS/link origins.
    const adminAppUrl = props.adminAppUrl ?? (props.adminCustomDomain ? `https://${props.adminCustomDomain.domainName}` : undefined);
    const publicAppUrl = props.publicAppUrl ?? (props.publicCustomDomain ? `https://${props.publicCustomDomain.domainName}` : undefined);
    const analyticsCtx = this.node.tryGetContext("enableAnalytics") as boolean | string | undefined;
    const enableAnalytics = analyticsCtx === true || analyticsCtx === "true";
    // Must match `LAKE_RETENTION_DAYS` in packages/domain/src/privacy.ts, which
    // is the figure an erasure report quotes back to the operator (#164).
    const analyticsEventRetentionDays = Number(
      (this.node.tryGetContext("analyticsEventRetentionDays") as string | undefined) ?? 730,
    );
    const analyticsStream = enableAnalytics
      ? new Stream(this, "AnalyticsStream", { streamMode: StreamMode.ON_DEMAND })
      : undefined;

    /**
     * Customer-managed key for the data plane (#202).
     *
     * DynamoDB's default is an AWS-OWNED key: no CloudTrail record of key usage,
     * no rotation control, and no crypto-shredding option — all three of which
     * an auditor expects on a multi-tenant PII store. The same key encrypts the
     * SNS topics, because SNS is NOT encrypted by default (unlike S3, DynamoDB
     * and Kinesis) and `SesEventsTopic` carries bounce and complaint
     * notifications containing subscriber email addresses.
     *
     * RETAIN and a 30-day pending window: a deleted KMS key makes every
     * ciphertext under it permanently unreadable, which for the subscriber table
     * is total data loss that no backup survives — the backup is encrypted with
     * the same key.
     *
     * Changing this on a LIVE table replaces it. Nothing is deployed yet, which
     * is exactly the window the issue names for doing it.
     */
    const dataKey = new Key(this, "DataKey", {
      description: "addressium: DynamoDB table, SNS topics, SQS queues",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      pendingWindow: Duration.days(30),
    });

    const table = new Table(this, "Table", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // `pointInTimeRecoverySpecification`, not the deprecated
      // `pointInTimeRecovery` boolean (#235). Same synthesized property; the old
      // spelling is on its way out, and a deprecation warning nobody clears is
      // how the runtime one survived until it was months from breaking.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: dataKey,
      stream: enableOpenSearchMirror ? StreamViewType.NEW_AND_OLD_IMAGES : undefined,
      kinesisStream: analyticsStream,
      // NEVER destroy subscriber, consent, or analytics data — in ANY stage.
      // This previously read `stage === "prod" ? RETAIN : DESTROY`, so every
      // non-prod deployment carried DeletionPolicy: Delete on the one table
      // holding every subscriber and every engagement event (#190). A typo in
      // the stage name had the same effect, since the comparison is a string
      // equality against a free-form value.
      removalPolicy: RemovalPolicy.RETAIN,
      // Belt and braces: DynamoDB refuses the delete itself, so even a
      // hand-rolled API call or a CloudFormation rollback cannot drop the table.
      // Turning this off is a deliberate, separate action.
      deletionProtection: true,
    });
    table.addGlobalSecondaryIndex({
      indexName: "gsi1", // email lookup
      partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: AttributeType.STRING },
    });
    table.addGlobalSecondaryIndex({
      indexName: "gsi2", // subscriber -> subscriptions
      partitionKey: { name: "gsi2pk", type: AttributeType.STRING },
      sortKey: { name: "gsi2sk", type: AttributeType.STRING },
    });
    /**
     * SPARSE index over CONFIRMED subscriptions only (#182).
     *
     * `listConfirmed` used a `FilterExpression`, which DynamoDB applies AFTER
     * reading — so every send paid read capacity for unsubscribed, bounced and
     * complained rows, and each of a campaign's fan-out slices re-read the whole
     * list. A 250-slice campaign did 250 full-list reads to send 250 windows.
     *
     * The index is sparse because `gsi3pk` is written ONLY when the status is
     * `confirmed`: a subscription that lapses simply stops carrying the
     * attribute and DynamoDB drops it from the index. So the index IS the
     * confirmed set — no filter, and nothing to pay for rows that would be
     * discarded.
     *
     * The sort key is the subscriber id, which is also the order fan-out slices
     * their key ranges in (#171). That makes a slice a native key-range query
     * rather than a full read plus an in-memory filter.
     *
     * KEYS_ONLY would be cheaper to store, but the send path needs each row's
     * status and consent, and a second get-per-recipient would trade storage for
     * a round trip on the hottest path in the system.
     */
    table.addGlobalSecondaryIndex({
      indexName: "gsi3", // confirmed subscriptions, ordered by subscriber id
      partitionKey: { name: "gsi3pk", type: AttributeType.STRING },
      sortKey: { name: "gsi3sk", type: AttributeType.STRING },
    });

    const archiveBucket = new Bucket(this, "ArchiveBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
    });
    const analyticsBucket = new Bucket(this, "AnalyticsBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Versioned like ArchiveBucket: the Firehose and export roles hold
      // s3:DeleteObject*, so without this the fact tier is unrecoverable.
      versioned: true,
      // Nothing expired anything here, while a FULL-table export ran nightly
      // into entities/ forever — unbounded cost, and every pre-erasure snapshot
      // kept a GDPR-erased subscriber's PII alive indefinitely (#185, #164).
      lifecycleRules: [
        {
          id: "expire-athena-results",
          prefix: "athena-results/",
          expiration: Duration.days(14),
          abortIncompleteMultipartUploadAfter: Duration.days(3),
        },
        {
          id: "expire-entity-snapshots",
          prefix: "entities/",
          expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(7),
        },
        {
          id: "expire-transform-errors",
          prefix: "events-errors/",
          expiration: Duration.days(30),
        },
        {
          id: "archive-events",
          prefix: "events/",
          transitions: [
            { storageClass: StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(90) },
          ],
          // A BOUNDED window, not "forever" (#164). The fact tier carries
          // `subscriber_id`, which is pseudonymous personal data — and an object
          // in S3 cannot be edited per subject, so a GDPR erasure relies on two
          // things: the tombstone every query anti-joins against, and this rule
          // eventually removing the rows outright. "Retained indefinitely" is
          // not a retention policy anyone can defend to a regulator.
          //
          // Two years by default, because year-over-year cohort reporting is the
          // reason the lake exists at all. `-c analyticsEventRetentionDays=…`
          // moves it; the domain's `LAKE_RETENTION_DAYS` is the same number, so
          // what an erasure REPORTS matches what the bucket enforces.
          expiration: Duration.days(analyticsEventRetentionDays),
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
    });
    // Bulk export staging (#224). Short-lived by construction: an export object
    // is the entire subscriber base of an org in one file, and the presigned URL
    // handed out for it cannot be revoked — so the object's own lifetime is the
    // backstop. Seven days, not "forever", and incomplete multipart uploads are
    // swept so an interrupted export is not billed indefinitely.
    //
    // Not versioned, unlike the archive and analytics buckets: a version here is
    // a second full copy of the same PII, and expiry would then have to chase
    // noncurrent versions to actually delete anything.
    const exportBucket = new Bucket(this, "ExportBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: "expire-exports",
          expiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });
    /**
     * Where a migration file lands before the import JOB reads it (#242).
     *
     * The console PUTs here with a presigned URL, so the bytes never traverse
     * API Gateway — an ordinary migration list clears the 10 MB payload ceiling,
     * and #239's base64 path inflates a gzipped export by a third on top.
     *
     * Expires on its own. An import file is the most sensitive object this
     * product ever holds — every subscriber's address and consent state in one
     * place — and there is no reason to keep it once the run that read it has
     * finished. The batch record is the durable artefact, not the file.
     */
    const importBucket = new Bucket(this, "ImportBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Browser uploads use a bearer presigned PUT. CORS is only the browser
      // permission layer; the URL remains scoped to one derived object and
      // expires after 15 minutes.
      cors: [{
        allowedOrigins: [adminAppUrl ? adminAppUrl.replace(/\/+$/, "") : "*"],
        allowedMethods: [HttpMethods.PUT],
        allowedHeaders: ["*"],
        exposedHeaders: ["ETag"],
        maxAge: 900,
      }],
      lifecycleRules: [
        {
          id: "expire-imports",
          expiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });
    // Audit log backed by S3 Object Lock (WORM) — history can't be rewritten
    // even by an admin (§4.19, docs/SECURITY.md §4.3, #29).
    //
    // GOVERNANCE, not COMPLIANCE (#9 [CHANGED r2], #219). Both make an object
    // immutable for the window; the difference is whether a mistake is
    // recoverable. Under GOVERNANCE a principal holding
    // s3:BypassGovernanceRetention can still delete — break-glass, and the
    // escape hatch GDPR erasure (#164) depends on. Under COMPLIANCE nobody can,
    // including AWS: a record written with the wrong tenant's PII would be
    // undeletable for the full window, and every dev stack would leave an
    // indestructible bucket behind (the bucket is RETAIN, so it outlives the
    // stack). This mode CANNOT be relaxed once an object has been written under
    // it, which is why it had to land before the first real deploy.
    //
    // `auditRetentionYears` is likewise set-once: it fixes the retention stamped
    // on every object written from here on.
    const auditRetentionYears = Number(
      (this.node.tryGetContext("auditRetentionYears") as string | undefined) ?? 7,
    );
    const auditBucket = new Bucket(this, "AuditBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: ObjectLockRetention.governance(
        Duration.days(365 * auditRetentionYears),
      ),
      removalPolicy: RemovalPolicy.RETAIN,
      // GLACIER_INSTANT_RETRIEVAL, deliberately NOT Deep Archive (#191). Seven
      // years of audit objects is real standing cost, but the console now reads
      // this bucket directly — and a Deep Archive object cannot be fetched at
      // all without a restore that takes hours, so the viewer would simply fail
      // on anything older than the transition. Instant Retrieval is same-
      // millisecond access at a lower rate, which is the trade that keeps the
      // log readable. Objects are tiny and written once, so 90 days of standard
      // storage covers every read anyone actually makes.
      lifecycleRules: [
        {
          id: "archive-audit-entries",
          transitions: [
            {
              storageClass: StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(90),
            },
          ],
        },
      ],
    });
    // Send pipeline queue with a dead-letter queue (#92): a message that fails
    // to send `maxReceiveCount` times lands in the DLQ instead of being lost, so
    // it can be inspected and replayed. Alarms below page ops when it fills.
    /**
     * Queue encryption, declared rather than inherited (#202).
     *
     * SQS does encrypt by default, but the synthesized template said nothing —
     * and an auditor reads the template, not the service documentation. Stating
     * it makes the posture reviewable.
     *
     * `SQS_MANAGED`, not the CMK above. `SesEventsTopic` publishes into
     * `EventsQueue`, and a customer-managed key on the queue additionally
     * requires a key policy admitting the SNS service principal — a second
     * failure mode (silently undelivered notifications) in exchange for control
     * over a key whose ciphertexts live for at most 14 days. The durable PII
     * store is the table, and that one has the CMK.
     */
    const queueEncryption = { encryption: QueueEncryption.SQS_MANAGED } as const;

    const sendDlq = new Queue(this, "SendDlq", {
      retentionPeriod: Duration.days(14),
      ...queueEncryption,
    });
    const sendQueue = new Queue(this, "SendQueue", {
      // Must exceed the sender's own timeout, or SQS redelivers a slice that is
      // still being worked and two invocations race on the same recipients.
      // The per-recipient claims make that safe rather than duplicating, but it
      // wastes the whole window. Sender timeout is 5 minutes (see SENDER_TIMEOUT)
      // plus headroom for the SDK's own retries on the last call.
      visibilityTimeout: Duration.minutes(6),
      deadLetterQueue: { queue: sendDlq, maxReceiveCount: 5 },
      ...queueEncryption,
    });
    // Engagement-event buffer (#218, compendium #20/#44). SES → SNS → SQS →
    // Lambda, NOT SNS → Lambda. An SNS→Lambda subscription is an ASYNCHRONOUS
    // invocation: AWS retries twice and then discards the event permanently. A
    // discarded bounce is an address that is never suppressed and keeps being
    // mailed, so the damage compounds silently and is invisible until
    // deliverability is already gone. The queue makes delivery durable and the
    // DLQ makes a failure inspectable and replayable.
    const eventsDlq = new Queue(this, "EventsDlq", {
      retentionPeriod: Duration.days(14),
      ...queueEncryption,
    });
    const eventsQueue = new Queue(this, "EventsQueue", {
      // Comfortably above the handler's own timeout so a slow batch is not
      // redelivered while it is still being processed.
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: { queue: eventsDlq, maxReceiveCount: 5 },
      ...queueEncryption,
    });
    const customerSyncDlq = new Queue(this, "CustomerSyncDlq", {
      fifo: true,
      contentBasedDeduplication: false,
      retentionPeriod: Duration.days(14),
      ...queueEncryption,
    });
    const customerSyncQueue = new Queue(this, "CustomerSyncQueue", {
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: { queue: customerSyncDlq, maxReceiveCount: 5 },
      ...queueEncryption,
    });
    // Encrypted at rest (#202). SNS is NOT encrypted by default, and this topic
    // carries bounce and complaint notifications containing subscriber emails.
    const sesEvents = new Topic(this, "SesEventsTopic", { masterKey: dataKey });
    // SES publishes engagement events here via each org's configuration-set
    // event destination. Without this policy SES is denied and the event plane
    // stays dead even once the destination exists (#208). SourceAccount stops
    // another account's SES pointing at this topic.
    sesEvents.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal("ses.amazonaws.com")],
        actions: ["SNS:Publish"],
        resources: [sesEvents.topicArn],
        conditions: { StringEquals: { "AWS:SourceAccount": Stack.of(this).account } },
      }),
    );
    // Publishing to an ENCRYPTED topic takes two grants, not one. The statement
    // above lets SES call sns:Publish; without this one SES is then denied at
    // the encryption step and every publish fails:
    //   "Access denied to KMS key for SNS topic <...>. Verify the KMS key policy
    //    grants Amazon SES the kms:GenerateDataKey and kms:Decrypt permissions."
    //
    // That surfaced as a 500 from POST /orgs — the event destination is created
    // during org provisioning, so the FIRST organization anyone adds fails, and
    // the message names SNS rather than the org being created. The queue side of
    // this was already reasoned about (see `queueEncryption` above, which picks
    // SQS_MANAGED precisely to avoid a second key policy); the SES -> SNS
    // direction was the half that got missed.
    dataKey.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal("ses.amazonaws.com")],
        actions: ["kms:GenerateDataKey*", "kms:Decrypt"],
        resources: ["*"], // a key policy's resource is always the key it is attached to
        conditions: { StringEquals: { "AWS:SourceAccount": Stack.of(this).account } },
      }),
    );
    // Where infra-level CloudWatch alarms go: DLQ depth, queue age, Lambda
    // errors/throttles, DynamoDB throttles (#92, #222).
    //
    // Prefer the operator's own topic (compendium #22/#32). A topic created
    // here starts with ZERO subscribers, and a stack that silently ships 26
    // alarms publishing into a void is worse than one with no alarms: it looks
    // monitored. So we take an ARN when given, create-and-subscribe when given
    // only an email, and when given neither we still synth — but deploy:check
    // says so loudly rather than letting it pass for monitoring.
    const externalOpsTopic = props.opsAlertTopicArn?.trim();
    const ownedOpsTopic = externalOpsTopic
      ? undefined
      : new Topic(this, "OpsAlertsTopic", { masterKey: dataKey });
    if (ownedOpsTopic && props.opsAlertEmail?.trim()) {
      ownedOpsTopic.addSubscription(new EmailSubscription(props.opsAlertEmail.trim()));
    }
    const opsAlerts = externalOpsTopic
      ? Topic.fromTopicArn(this, "OpsAlertsTopicImported", externalOpsTopic)
      : (ownedOpsTopic as Topic);

    // The SPA distributions are created near the end of this stack, but the
    // Cognito callback URLs and the API's CORS origins need them. Lazy defers
    // resolution to synth, after the whole constructor has run, so we keep a
    // single source of truth instead of hardcoding a URL.
    let adminSite: StaticSite | undefined;
    let publicSite: StaticSite | undefined;
    // Origins carry NO trailing slash — browsers send `Origin: https://host`, so
    // a stored "https://host/" would never match and CORS would silently fail.
    // The OAuth callback does need the trailing slash (the SPA's redirect_uri is
    // `window.location.origin + "/"`), so it is appended separately below.
    const siteOrigin = (get: () => StaticSite | undefined, what: string) =>
      Lazy.string({
        produce: () => {
          const site = get();
          if (!site) throw new Error(`${what} was never created`);
          return `https://${site.distribution.domainName}`;
        },
      });
    const stripSlash = (u: string) => u.replace(/\/+$/, "");
    const adminOrigin = adminAppUrl ? stripSlash(adminAppUrl) : siteOrigin(() => adminSite, "AdminSite");
    const publicOrigin = publicAppUrl ? stripSlash(publicAppUrl) : siteOrigin(() => publicSite, "PublicSite");
    // Token-safe concatenation: this resolves to an Fn::Join at synth.
    const adminCallbackUrl = `${adminOrigin}/`;

    // ---- admin pool (control plane, seeded so first login works — §9.1) ----
    const adminPool = new UserPool(this, "AdminPool", {
      selfSignUpEnabled: false,
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      signInAliases: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // Server-side RBAC derives the caller's grant from these claims. Without
      // them declared they cannot be set on a user at all, so grantFromClaims
      // threw and EVERY RBAC-gated endpoint returned 403 (#161).
      customAttributes: {
        role: new StringAttribute({ mutable: true }),
        orgs: new StringAttribute({ mutable: true }),
      },
      // Operator identities + MFA enrollments. Losing these locks every admin out
      // of the console, so retain in every stage (#190).
      removalPolicy: RemovalPolicy.RETAIN,
      // Send operator invites and password resets through SES when the operator
      // names a FROM address, and fall back to Cognito's own sender when they do
      // not — the pool has to stand up on a fresh account where no identity is
      // verified yet, and that bootstrapping order is why this is optional
      // rather than required.
      //
      // Worth configuring, though: the Cognito default caps at 50 emails/day
      // ACCOUNT-WIDE, sends from a shared amazonses.com address whose reputation
      // is not yours, and emits no bounce, metric or log of any kind. The first
      // invite on this stack simply never arrived, and nothing anywhere could
      // say whether it had been delivered, filtered or dropped. SES gives the
      // per-identity reputation this project already tracks for subscriber mail.
      //
      // sesVerifiedDomain is deliberately NOT set: Cognito derives the identity
      // from the address, and naming a domain that is verified in a different
      // region or not at all fails the stack update rather than the send.
      ...(props.adminFromEmail?.trim()
        ? {
            email: UserPoolEmail.withSES({
              fromEmail: props.adminFromEmail.trim(),
              fromName: "addressium",
              sesRegion: Stack.of(this).region,
            }),
          }
        : {}),
    });
    const adminHostedUi = adminPool.addDomain("AdminHostedUi", {
      cognitoDomain: { domainPrefix: `${props.adminHostedUiDomainPrefix}-${props.stage}` },
    });
    const adminClient = new UserPoolClient(this, "AdminClient", {
      userPool: adminPool,
      generateSecret: false,
      authFlows: { userSrp: true },
      // Don't leak whether an admin address exists.
      preventUserExistenceErrors: true,
      // Omitting `oAuth` takes CDK's defaults: callbackUrls ["https://example.com"]
      // (so Hosted-UI login fails with redirect_mismatch), the IMPLICIT grant
      // enabled (tokens in the URL fragment, bypassing PKCE), and the
      // aws.cognito.signin.user.admin scope. All three are wrong here (#160).
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: [adminCallbackUrl],
        logoutUrls: [adminCallbackUrl],
      },
      // role/orgs must NEVER be client-writable, or a token could self-promote
      // via UpdateUserAttributes. readAttributes stays at the default so the
      // claims still appear in the ID token.
      writeAttributes: new ClientAttributes().withStandardAttributes({ email: true }),
    });
    props.adminEmails.forEach((email, i) => {
      new CfnUserPoolUser(this, `AdminSeed${i}`, {
        userPoolId: adminPool.userPoolId,
        username: email,
        desiredDeliveryMediums: ["EMAIL"],
        userAttributes: [
          { name: "email", value: email },
          { name: "email_verified", value: "true" },
          // Bootstrap admins need a grant or they authenticate successfully and
          // then 403 on everything — grantFromClaims requires both claims (#161).
          { name: "custom:role", value: "developer_admin" },
          { name: "custom:orgs", value: "*" },
        ],
      });
    });

    /**
     * A real backup, separate from the table's own lifecycle (#190).
     *
     * PITR is enabled and is NOT a backup: it is a 35-day continuous window that
     * lives inside the table and dies with it. Deletion protection plus a RETAIN
     * removal policy make deleting the table hard, but "hard" is not "recovered
     * from" — a bad migration, a mass overwrite by a runaway import, or an
     * account-level incident all leave the data gone with PITR gone alongside it.
     * AWS Backup writes to a vault that is a different resource with a different
     * lifecycle, which is the property that makes it a backup.
     *
     * Daily at 05:00 UTC, kept 35 days to match the PITR window (so the two
     * cover the same period through different mechanisms rather than leaving a
     * gap), plus a monthly copy kept a year for the "we noticed in March that
     * something broke in January" case.
     *
     * On by default in prod ONLY. It has a standing cost proportional to table
     * size, and a scratch stage that silently started billing for backups would
     * be exactly the kind of surprise this project avoids elsewhere. Both
     * directions are overridable: `-c enableBackup=true|false`.
     */
    const backupCtx = this.node.tryGetContext("enableBackup") as boolean | string | undefined;
    const enableBackup =
      backupCtx === undefined ? stage === "prod" : backupCtx === true || backupCtx === "true";
    if (enableBackup) {
      const vault = new BackupVault(this, "BackupVault", {
        // The vault outlives the stack on purpose. A vault destroyed with the
        // stack is a backup that disappears at exactly the moment it is needed.
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const plan = new BackupPlan(this, "BackupPlan", { backupVault: vault });
      plan.addRule(
        new BackupPlanRule({
          ruleName: "daily-35d",
          scheduleExpression: Schedule.cron({ minute: "0", hour: "5" }),
          deleteAfter: Duration.days(35),
        }),
      );
      plan.addRule(
        new BackupPlanRule({
          ruleName: "monthly-1y",
          scheduleExpression: Schedule.cron({ minute: "0", hour: "5", day: "1" }),
          deleteAfter: Duration.days(365),
        }),
      );
      plan.addSelection("TableSelection", { resources: [BackupResource.fromDynamoDbTable(table)] });
      new CfnOutput(this, "BackupVaultName", { value: vault.backupVaultName });
    }

    // ---- application secrets (passed by ARN; handlers resolve at cold start) ----
    // RETAIN, in every stage (#190). `ConfirmSecret` signs every outstanding
    // double-opt-in and one-click-unsubscribe token: losing it does not just
    // break new links, it invalidates every link already sitting in someone's
    // inbox — including the unsubscribe link the law requires to work. Secrets
    // Manager's own 7-30 day recovery window only applies to a DELETE we asked
    // for; a CloudFormation removal with DeletionPolicy: Delete does not get one.
    const confirmSecret = new Secret(this, "ConfirmSecret", {
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Rotation is added further down, once the bundler helper exists — see
    // `ConfirmSecretRotationFn` (#234). It APPENDS a key rather than replacing
    // one, which is the only shape of rotation this secret can survive.
    const webhookSecret = new Secret(this, "WebhookSecret", {
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- handler functions ----
    const baseEnv = { TABLE_NAME: table.tableName };
    let versionMarker: CustomResource | undefined;
    const fn = (
      id: string,
      entry: string,
      handler: string,
      extraEnv: Record<string, string> = {},
      // Per-function override. Only the sender needs one: everything else is a
      // request/response handler that has no business running for minutes, and
      // 30s is the right ceiling for those.
      opts: { timeout?: Duration } = {},
    ) => {
      const result = new NodejsFunction(this, id, {
        entry,
        handler,
        // nodejs22.x (#235). AWS disabled CREATION of nodejs20.x functions on
        // 2027-02-01, and this project has never been deployed — a first deploy
        // is all creates, so the deprecation would have failed the very first
        // `cdk deploy` anyone ever ran, at the worst possible moment.
        //
        // 22 rather than 24 to match the `engines` field and CI's Node version:
        // one major across build, bundle target and runtime means the code that
        // passes tests is the code that runs. Deliberately NOT `NODEJS_LATEST`,
        // which silently changes what you deployed between two runs of the same
        // commit.
        runtime: Runtime.NODEJS_22_X,
        timeout: opts.timeout ?? Duration.seconds(30),
        environment: { ...baseEnv, ...extraEnv },
        bundling: {
          format: "esm" as never,
          target: "node22",
          // @cedar-policy/cedar-wasm is a wasm-pack "nodejs" build: its JS does
          // `readFileSync(`${__dirname}/cedar_wasm_bg.wasm`)`. esbuild can
          // inline the JS but NOT the binary sidecar, so bundling it produced
          // handlers that threw on first invoke —
          //   ReferenceError: __dirname is not defined in ES module scope
          // — and every RBAC-checking Lambda (28 of 29) was dead on arrival
          // while the stack still reported CREATE_COMPLETE.
          //
          // Listing it here makes CDK `npm install` the package into the asset
          // instead of inlining it, so it ships as real CommonJS with its own
          // package.json (where __dirname genuinely exists) and the .wasm file
          // sitting next to it. A banner shim defining __dirname would NOT fix
          // this — it resolves, then fails ENOENT on the missing .wasm.
          //
          // This is also why the eight services that use @addressium/rbac each
          // declare cedar-wasm directly, despite importing it only transitively:
          // `nodeModules` resolves the version by walking UP from the handler
          // ENTRY file (findUp "package.json"), so it reads
          // services/<name>/package.json — not infra/cdk's, and not the root's.
          // Declaring it anywhere else fails synth with
          // CannotExtractModuleVersion. CDK's fallback of requiring
          // '<mod>/package.json' cannot rescue it either: cedar-wasm's `exports`
          // map does not expose ./package.json. Keep those ranges in step with
          // packages/rbac.
          //
          // ALL 12 services declare it, not just the 8 that use RBAC, because
          // this option is set on the shared `fn()` helper and so applies to
          // every function. analytics-export, feeds, privacy and segment-indexer
          // never import cedar and it costs them a couple of unused MB in the
          // asset — but removing it there breaks `cdk synth` outright, which is
          // how 18 template tests failed once already. It is not dead weight to
          // be tidied away.
          nodeModules: ["@cedar-policy/cedar-wasm"],
          // esbuild's ESM output replaces CommonJS `require` with a stub that
          // throws `Dynamic require of "x" is not supported`. The AWS SDK hits
          // it — @smithy/util-buffer-from does `require("buffer")` at module
          // scope — so without this every handler dies on first invoke. This
          // was masked until now: cedar failed earlier in module load, so the
          // SDK's turn never came.
          //
          // createRequire gives ESM a real CommonJS require bound to this file,
          // which is the supported way to satisfy such calls. Also defining
          // __filename/__dirname because bundled CJS dependencies reach for them
          // just as readily, and a second round-trip to discover that costs a
          // deploy.
          banner: [
            "import{createRequire as __cdkCreateRequire}from'module';",
            "import{fileURLToPath as __cdkFileURLToPath}from'url';",
            "import{dirname as __cdkDirname}from'path';",
            "const require=__cdkCreateRequire(import.meta.url);",
            "const __filename=__cdkFileURLToPath(import.meta.url);",
            "const __dirname=__cdkDirname(__filename);",
          ].join(""),
        },
        // Lambda's default log retention is NEVER EXPIRE. With ~40 functions
        // that is unbounded CloudWatch cost forever (#187).
        logGroup: new LogGroup(this, `${id}Logs`, {
          retention: stage === "prod" ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });
      // The migration function itself creates the marker. Every application
      // handler is ordered after it, so an update cannot expose code expecting
      // a new shape before its migration has completed.
      if (versionMarker) result.node.addDependency(versionMarker);
      return result;
    };

    // ses:SendEmail scoped to *this account's* SES identities + configuration
    // sets (#93). Per-org identities/config-sets are created by provisioning at
    // runtime so their exact ARNs can't be enumerated here, but restricting to
    // this account/region's `identity/*` and `configuration-set/*` is a real
    // tightening from `resources: ["*"]` (blocks sending as any other account's
    // verified identity). A fresh statement per caller keeps roles independent.
    /**
     * Per-org secrets are created at runtime under `addressium/{orgId}/…`, so
     * exact ARNs can't be enumerated at synth — but scoping to that name prefix
     * in this account/region stops these handlers from reading EVERY secret in
     * the account, which is what `resources: ["*"]` allowed (#166). Reachable
     * unauthenticated via /signup, so the blast radius mattered. Secrets Manager
     * appends a 6-character suffix to the ARN, hence the trailing `*`.
     *
     * Stack-created secrets (confirm, webhook) are granted precisely via
     * `grantRead` elsewhere and deliberately do NOT rely on this.
     */
    const orgSecretsScoped = () =>
      new PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          Stack.of(this).formatArn({
            service: "secretsmanager",
            resource: "secret",
            resourceName: "addressium/*",
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      });

    const sesSendScoped = () =>
      new PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: [
          Stack.of(this).formatArn({ service: "ses", resource: "identity", resourceName: "*" }),
          Stack.of(this).formatArn({ service: "ses", resource: "configuration-set", resourceName: "*" }),
        ],
      });

    /**
     * Concurrent sender invocations (#176). The SES rate is an ACCOUNT limit but
     * the TokenBucket is per-invocation, so this is the multiplier that has to
     * be divided back out — see SENDER_MAX_CONCURRENCY below and the sender's
     * own rate calculation.
     */
    const SENDER_MAX_CONCURRENCY = Number(
      (this.node.tryGetContext("senderMaxConcurrency") as string | undefined) ?? 5,
    );
    /**
     * The account's SES send rate (messages/second), from the operator.
     *
     * There is deliberately NO DEFAULT. The old default of 14 — a fresh
     * production account's rate — looked configured, deployed clean, and
     * silently throttled an account allowing 210/s to a fifteenth of its
     * capacity. A 20,000-recipient publication took 24 minutes instead of 95
     * seconds and blew the sender's Lambda timeout. A wrong-but-plausible
     * default is worse than none: this one hid for as long as nobody measured.
     *
     * Read yours with:
     *   aws sesv2 get-account --query 'SendQuota.MaxSendRate'
     *
     * This is THIS STACK'S SHARE of the quota, not necessarily the account
     * maximum — the quota is per account per region, so several stacks (or a
     * legacy sender still running alongside) must divide it between them.
     *
     * Everything that sends divides this down rather than each taking it whole,
     * so the aggregate stays inside the quota (#176).
     */
    /**
     * Subscriber-facing base URLs — DERIVED from the public distribution this
     * stack creates, and overridable by context.
     *
     * They used to default to a `your-site.example` placeholder, a domain nobody
     * owns, and nothing anywhere reported it: signup returned 200, the
     * preference-centre request returned 200, both sent mail, and every link in
     * that mail was dead. Double opt-in and the preference centre were broken in
     * a way that looks exactly like working.
     *
     * Deriving beats requiring. The obvious fix was to throw when unset, the way
     * `sesMaxSendRate` does — but that knob is genuinely unknowable to the stack
     * (it is an account-level SES quota), whereas THIS stack builds the very
     * distribution these links point at. Requiring it would have made a first
     * deploy impossible: the error told the operator to use a stack output that
     * does not exist until the stack has deployed.
     *
     * `publicOrigin` is the same Lazy token the Cognito callbacks and CORS
     * origins use, so it resolves at synth to an Fn::Join over the distribution
     * domain and cannot drift from the site actually serving these routes.
     */
    const confirmUrlBase =
      (this.node.tryGetContext("confirmUrlBase") as string | undefined)?.trim() ||
      `${publicOrigin}/confirm`;
    const preferencesUrlBase =
      (this.node.tryGetContext("preferencesUrlBase") as string | undefined)?.trim() ||
      `${publicOrigin}/preferences`;

    const sesRateContext = this.node.tryGetContext("sesMaxSendRate") as string | undefined;
    if (sesRateContext === undefined || String(sesRateContext).trim() === "") {
      throw new Error(
        "sesMaxSendRate is required. Set it in infra/cdk/addressium.config.json to this stack's " +
          "share of the account SES rate. Read the account quota with: " +
          "aws sesv2 get-account --query 'SendQuota.MaxSendRate'",
      );
    }
    const sesQuotaRate = Number(sesRateContext);
    if (!Number.isFinite(sesQuotaRate) || sesQuotaRate <= 0) {
      throw new Error(`sesMaxSendRate must be a positive number, got ${JSON.stringify(sesRateContext)}`);
    }
    /**
     * Send BELOW the quota, never at it.
     *
     * Concurrency is not rate: actual throughput is roughly
     * `concurrency / per-call SES latency`, and that latency drifts with
     * payload size, region load and TLS handshakes. Pinned to exactly the
     * quota, ordinary jitter crosses the line — and SES DROPS over-rate mail
     * rather than queueing it ("Amazon SES drops the message and doesn't
     * attempt to redeliver it"). The sender's claim-release-rethrow recovers
     * those recipients, but a retry storm inside a send window is worth
     * avoiding by construction rather than by recovery.
     *
     * Not configurable: an operator who wants to send slower sets a lower
     * `sesMaxSendRate`, which is the same lever with an honest name.
     */
    const SES_RATE_HEADROOM = 0.85;
    const SES_MAX_SEND_RATE = String(Math.max(1, Math.floor(sesQuotaRate * SES_RATE_HEADROOM)));

    /**
     * Guaranteed capacity for the routes that must answer during a big send
     * (#176).
     *
     * `reservedConcurrentExecutions` carves a slice out of the account pool that
     * nothing else can consume. Without it a large campaign's senders take the
     * pool and throttle the PUBLIC endpoints — including `/unsubscribe`, which
     * is a compliance obligation, not a feature. "We could not process your
     * unsubscribe because we were busy sending you email" is the worst sentence
     * this system could produce.
     *
     * Small numbers on purpose: this is a floor these functions always have, not
     * a ceiling they are expected to reach.
     */
    const reservePublic = (f: NodejsFunction, n = 10): void => {
      (f.node.defaultChild as CfnFunction).addPropertyOverride(
        "ReservedConcurrentExecutions",
        n,
      );
    };

    // A real install/upgrade boundary (#213). The custom-resource properties
    // make CloudFormation invoke it on every release/schema change; its handler
    // executes ordered migrations and writes the singleton marker only on
    // success. Existing installs with no marker are recognized as schema 1,
    // whose table shape was already created by this stack.
    const migrationFn = fn(
      "MigrationFn",
      svc("services/api/src/migrations.ts"),
      "migrationHandler",
      { APP_VERSION, EXPECTED_SCHEMA_VERSION: String(EXPECTED_SCHEMA_VERSION) },
    );
    table.grantReadWriteData(migrationFn);
    const migrationProvider = new Provider(this, "MigrationProvider", {
      onEventHandler: migrationFn,
      logRetention: stage === "prod" ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_WEEK,
    });
    versionMarker = new CustomResource(this, "VersionMarker", {
      serviceToken: migrationProvider.serviceToken,
      properties: {
        ApplicationVersion: APP_VERSION,
        SchemaVersion: EXPECTED_SCHEMA_VERSION,
      },
    });

    const apiEntry = svc("services/api/src/index.ts");
    const apiEnv = {
      CONFIRM_SECRET_ARN: confirmSecret.secretArn,
      ARCHIVE_BUCKET: archiveBucket.bucketName,
      WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      AUDIT_BUCKET: auditBucket.bucketName, // WORM audit sink (#29)
      EXPORT_BUCKET: exportBucket.bucketName, // bulk export staging (#224)
      CUSTOMER_SYNC_QUEUE_URL: customerSyncQueue.queueUrl,
    };
    const signupFn = fn("SignupFn", apiEntry, "signupHandler", {
      ...apiEnv,
      CONFIRM_URL_BASE: confirmUrlBase,
    });
    signupFn.addToRolePolicy(
      sesSendScoped(),
    );
    // /signup now verifies the org's reCAPTCHA secret too (#170).
    signupFn.addToRolePolicy(orgSecretsScoped());
    reservePublic(signupFn);
    const signupBatchFn = fn("SignupBatchFn", apiEntry, "signupBatchHandler", {
      ...apiEnv,
      CONFIRM_URL_BASE: confirmUrlBase,
    });
    signupBatchFn.addToRolePolicy(
      sesSendScoped(),
    );
    // The embed widget's reCAPTCHA secret is org-configured at runtime (#62).
    signupBatchFn.addToRolePolicy(orgSecretsScoped());
    reservePublic(signupBatchFn);
    /**
     * The ONLY role in this stack that may write to an operator's subscriber
     * pool (#23, #62). It is not wired to any API route — nothing can reach it
     * from the internet — and `confirmHandler` invokes it asynchronously after a
     * double opt-in.
     *
     * The split is the point. `/confirm` is the most exposed route in the
     * product: unauthenticated, linked from every confirmation email, and the
     * one an attacker probes first. Holding `AdminCreateUser` there meant a
     * compromise of that route reached the operator's user directory. Now it
     * holds `lambda:InvokeFunction` on this one function and nothing else, and
     * the pool id is re-read from the org record here rather than trusted from
     * the payload — otherwise an invoker naming an arbitrary pool would have
     * back the escalation this removes.
     */
    const subscriberAccountFn = fn(
      "SubscriberAccountFn",
      apiEntry,
      "subscriberAccountHandler",
      apiEnv,
    );
    table.grantReadWriteData(subscriberAccountFn);
    // Subscriber pools belong to the OPERATOR and are linked at runtime, so
    // their ARNs cannot be enumerated at synth. Naming them in context is what
    // turns this from "every pool in the account" into the two or three that
    // are actually linked — worth doing, and the reason the option exists.
    const linkedPoolIds =
      (this.node.tryGetContext("subscriberPoolIds") as string[] | undefined) ?? [];
    subscriberAccountFn.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminSetUserPassword",
        ],
        resources:
          linkedPoolIds.length > 0
            ? linkedPoolIds.map((id) =>
                Stack.of(this).formatArn({
                  service: "cognito-idp",
                  resource: "userpool",
                  resourceName: id,
                }),
              )
            : [
                Stack.of(this).formatArn({
                  service: "cognito-idp",
                  resource: "userpool",
                  resourceName: "*",
                }),
              ],
      }),
    );
    // The wildcard fallback still leaves every pool in THIS account in range —
    // including the admin pool. An explicit Deny (which always wins in IAM)
    // closes the escalation that actually matters: provisioning a subscriber
    // account into the control plane's own directory (#167).
    subscriberAccountFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ["cognito-idp:*"],
        resources: [adminPool.userPoolArn],
      }),
    );

    const confirmFn = fn("ConfirmFn", apiEntry, "confirmHandler", {
      ...apiEnv,
      SUBSCRIBER_ACCOUNT_FN: subscriberAccountFn.functionName,
    });
    // Invoke only, on that one function. `/confirm` can ask for provisioning; it
    // cannot perform it, and it cannot reach Cognito at all.
    subscriberAccountFn.grantInvoke(confirmFn);
    customerSyncQueue.grantSendMessages(confirmFn);
    reservePublic(confirmFn);
    const unsubscribeFn = fn("UnsubscribeFn", apiEntry, "unsubscribeHandler", apiEnv);
    customerSyncQueue.grantSendMessages(unsubscribeFn);
    // The one route that must NEVER be starved by a send in progress.
    reservePublic(unsubscribeFn, 20);
    const entitlementFn = fn("EntitlementFn", apiEntry, "entitlementSyncHandler", apiEnv);
    const identityFn = fn("IdentityFn", apiEntry, "identitySyncHandler", apiEnv);

    // The sender resolves each org's KMS key + SES config from the org record at
    // send time (§4.11), so no per-org env here.
    // The sender re-enqueues fan-out slices onto the same queue, so it needs the
    // queue URL (services/sender reads SEND_QUEUE_URL at module scope and calls
    // it on the first, unsliced message of every campaign) and send permission.
    /**
     * How long one sender invocation may run, and how many recipients a slice
     * may therefore hold.
     *
     * These two and SES_MAX_SEND_RATE are ONE calculation, not three knobs.
     * They used to be independent — a 30s timeout, a hardcoded 2000-recipient
     * chunk, and a rate that defaulted to 14 — and they silently disagreed: a
     * slice needed 714 seconds of work and got 30, so ~21% of each slice was
     * delivered and the rest dead-lettered. Deriving the chunk from the other
     * two makes that disagreement impossible to reintroduce by editing one
     * value.
     *
     * The 0.8 leaves room for the per-recipient work that is not sending —
     * merge resolution, token minting, rendering, the claim write — plus the
     * cold start. A slice that finishes early costs nothing; one that does not
     * finish costs a redelivery and five minutes of visibility timeout.
     */
    const SENDER_TIMEOUT = Duration.minutes(5);
    const perInvocationRate = Number(SES_MAX_SEND_RATE) / SENDER_MAX_CONCURRENCY;
    const SEND_CHUNK_SIZE = String(
      Math.max(1, Math.floor(perInvocationRate * SENDER_TIMEOUT.toSeconds() * 0.8)),
    );

    const senderFn = fn(
      "SenderFn",
      svc("services/sender/src/index.ts"),
      "handler",
      {
      SEND_QUEUE_URL: sendQueue.queueUrl,
      // How many senders may run at once. The sender divides the account SES
      // rate by this to get its own per-invocation budget, so the AGGREGATE
      // across all concurrent senders stays inside the quota (#176). One value,
      // passed to both the event source and the code that has to respect it.
      SENDER_MAX_CONCURRENCY: String(SENDER_MAX_CONCURRENCY),
      SES_MAX_SEND_RATE,
      // RFC 8058 one-click unsubscribe: the header must point at the real route
      // and carry a signed token, so the sender needs both the API base and the
      // confirm secret (#178). Without them it degrades to a mailto header.
      UNSUBSCRIBE_URL_BASE: Lazy.string({ produce: () => `${api.apiEndpoint}/unsubscribe` }),
      CONFIRM_SECRET_ARN: confirmSecret.secretArn,
      // Derived above from rate x timeout, never set by hand.
      SEND_CHUNK_SIZE,
      },
      { timeout: SENDER_TIMEOUT },
    );
    // Per-org signing keys are created by provisioning at runtime, so we can't
    // enumerate their ARNs here; scope by an addressium key-tag condition + SES.
    senderFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["kms:Sign"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:ResourceTag/app": "addressium" } },
      }),
    );
    senderFn.addToRolePolicy(sesSendScoped());
    sendQueue.grantSendMessages(senderFn); // fan-out slices back onto the queue
    // Which segment engine this deployment resolves with (#246). ONE expression
    // feeding both consumers, because they must never disagree: the sender picks
    // the engine, and the admin API refuses to SAVE a predicate that engine
    // cannot resolve. If the API believed OpenSearch were live while the sender
    // used the GSI engine, the product would accept a segment guaranteed to
    // throw mid-campaign — precisely the #246 failure, one layer up.
    //
    // The sender additionally gets OPENSEARCH_ENDPOINT below, inside the
    // `enableOpenSearchMirror` block, because that is where the collection it
    // names actually exists.
    const segmentEngine = enableOpenSearchMirror ? "opensearch" : "gsi";
    const eventsFn = fn("EventsFn", svc("services/events/src/index.ts"), "handler");

    // Customer-record updates are deliberately a separate FIFO pipeline. A
    // slow or unavailable external system must never block subscribe or
    // unsubscribe, while FIFO ordering keeps one organization's changes in
    // the order they occurred and the DLQ makes exhausted deliveries visible.
    const customerSyncFn = fn(
      "CustomerSyncFn",
      svc("services/customer-sync/src/index.ts"),
      "handler",
    );
    table.grantReadData(customerSyncFn);
    customerSyncQueue.grantConsumeMessages(customerSyncFn);
    customerSyncFn.addToRolePolicy(orgSecretsScoped());
    customerSyncFn.addEventSource(
      new SqsEventSource(customerSyncQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    // Launch handler for recurring series (EventBridge Scheduler target, §4.16).
    const launchFn = fn("LaunchFn", svc("services/automations/src/index.ts"), "handler", {
      SEND_QUEUE_URL: sendQueue.queueUrl,
    });
    sendQueue.grantSendMessages(launchFn); // each firing enqueues an edition

    /**
     * Weekly re-engagement / sunset sweep (#233, §4.22).
     *
     * ONE rule for the whole deployment, fanning out to the orgs that opted in.
     * The sweep's terminal step UNSUBSCRIBES cold subscribers, so it is
     * per-org opt-in (`Organization.reengagement.enabled`) rather than on by
     * default: a deployment-wide default would start silently shrinking lists on
     * installs where nobody asked for it, and a shrunk list is not something an
     * operator can undo.
     *
     * Weekly, not daily. Step spacing is measured in days and the default policy
     * waits 180 days for coldness, so a daily pass would do nothing 6 days out of
     * 7 while paying for a full org scan each time.
     *
     * 15 minutes, not the default 30 seconds: this is the only handler that
     * walks an entire org. It checkpoints and resumes, so a timeout costs one
     * page rather than the pass — but a longer budget means fewer resumptions.
     */
    const reengagementFn = fn(
      "ReengagementSweepFn",
      svc("services/automations/src/index.ts"),
      "reengagementDispatchHandler",
      { SES_MAX_SEND_RATE },
    );
    // 15 minutes, not the shared 30-second default. This is the only handler
    // that walks an entire org, and while it checkpoints — so a timeout costs
    // one page rather than the pass — a 30-second budget would mean resuming
    // constantly and a large org would take weeks of firings to sweep once.
    (reengagementFn.node.defaultChild as CfnFunction).addPropertyOverride("Timeout", 900);
    reengagementFn.addToRolePolicy(sesSendScoped());
    reengagementFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["kms:Sign"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:ResourceTag/app": "addressium" } },
      }),
    );
    table.grantReadWriteData(reengagementFn);
    new Rule(this, "ReengagementSweepSchedule", {
      // 04:00 UTC on Mondays — off-peak, and clear of the 03:00 analytics export.
      schedule: Schedule.cron({ minute: "0", hour: "4", weekDay: "MON" }),
      targets: [new LambdaFunction(reengagementFn)],
      description: "addressium: weekly re-engagement sweep for orgs that opted in (#233)",
    });

    // ---- SES suppression reconciliation (#318) ----
    //
    // SES keeps its own suppression list and adds every hard bounce to it. Ours
    // and theirs drift apart, and sending to an address SES has suppressed does
    // NOT fail — SES accepts the message, discards it, and still counts it
    // against the daily quota and the per-second rate. A stale list quietly
    // spends send budget on mail that reaches nobody.
    //
    // One way only: our unsubscribes and inactivity sweeps are marketing-scope
    // and must never be pushed to SES, which would block transactional mail too.
    const suppressionSyncFn = fn(
      "SuppressionSyncFn",
      svc("services/automations/src/index.ts"),
      "suppressionSyncHandler",
      apiEnv,
      // Iterates every org and pages the whole SES list for each; well inside
      // five minutes at any plausible org count, and it does not block a send.
      { timeout: Duration.minutes(5) },
    );
    table.grantReadWriteData(suppressionSyncFn);
    suppressionSyncFn.addToRolePolicy(
      new PolicyStatement({
        // Read-only. The sync never writes to SES's list — see the one-way note
        // above — so `PutSuppressedDestination` is deliberately absent.
        actions: ["ses:ListSuppressedDestinations", "ses:GetSuppressedDestination"],
        resources: ["*"],
      }),
    );
    new Rule(this, "SuppressionSyncSchedule", {
      // 02:00 UTC daily — before the 03:00 analytics export and hours clear of
      // any morning send window, so a long page-through cannot contend with one.
      schedule: Schedule.cron({ minute: "0", hour: "2" }),
      targets: [new LambdaFunction(suppressionSyncFn)],
      description: "addressium: daily SES suppression-list reconciliation (#318)",
    });

    // ---- ConfirmSecret rotation (#234) ----
    //
    // This secret signs the double opt-in link and the RFC 8058 one-click
    // unsubscribe link — the latter is in EVERY message ever sent and the law
    // requires it to keep working. So the rotation function APPENDS a key to a
    // keyring rather than replacing one. Attaching an ordinary rotation to a
    // single-key secret would have been worse than no rotation: it would have
    // invalidated every outstanding link, on a schedule, silently.
    //
    // The function's `testSecret` step proves a token signed by the OUTGOING key
    // still verifies under the staged keyring before anything is promoted, so a
    // rotation that would orphan live links fails instead of shipping.
    const confirmRotationFn = fn(
      "ConfirmSecretRotationFn",
      svc("services/automations/src/rotate-confirm-secret.ts"),
      "rotateConfirmSecretHandler",
      {},
    );
    confirmSecret.grantRead(confirmRotationFn);
    confirmSecret.grantWrite(confirmRotationFn);
    confirmRotationFn.addToRolePolicy(
      new PolicyStatement({
        // grantRead/grantWrite do not cover the staging-label move that
        // `finishSecret` performs, nor the DescribeSecret it reads the current
        // version id from.
        actions: ["secretsmanager:UpdateSecretVersionStage", "secretsmanager:DescribeSecret"],
        resources: [confirmSecret.secretArn],
      }),
    );
    confirmSecret.addRotationSchedule("Rotation", {
      rotationLambda: confirmRotationFn,
      // Yearly, not the 30-day default. Rotation cadence should be proportional
      // to exposure, and this key never leaves Secrets Manager and the handler
      // memory that reads it. Every rotation permanently adds a key to the ring
      // — the ring is the overlap window, and unsubscribe tokens live five years
      // — so a 30-day cadence would carry ~60 keys before the oldest stopped
      // mattering, for no gain over yearly.
      automaticallyAfter: Duration.days(365),
    });

    // ---- drip automations state machine (§4.6, #23) ----
    // Each step: Wait(waitSeconds) → Task(dripStepHandler) → Choice(done?) loop.
    // The domain owns the per-step choice; the machine just orchestrates.
    const dripStepFn = fn("DripStepFn", svc("services/automations/src/index.ts"), "dripStepHandler", {
      SEND_QUEUE_URL: sendQueue.queueUrl,
      // Automations pace themselves too, at a fraction of the account rate —
      // they run alongside campaigns and must not starve a scheduled send (#176).
      SES_MAX_SEND_RATE,
    });
    sendQueue.grantSendMessages(dripStepFn);
    dripStepFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["kms:Sign"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:ResourceTag/app": "addressium" } },
      }),
    );
    dripStepFn.addToRolePolicy(
      sesSendScoped(),
    );

    const waitStep = new Wait(this, "DripWait", {
      time: WaitTime.secondsPath("$.nextWaitSeconds"),
    });
    // The handler echoes routing (orgId/sequenceId/subscriberId) + next-step
    // fields, so the whole state is the loop carrier — no Pass needed.
    const runStep = new LambdaInvoke(this, "DripRunStep", {
      lambdaFunction: dripStepFn,
      payload: TaskInput.fromObject({
        orgId: JsonPath.stringAt("$.orgId"),
        sequenceId: JsonPath.stringAt("$.sequenceId"),
        subscriberId: JsonPath.stringAt("$.subscriberId"),
        stepIndex: JsonPath.numberAt("$.nextStepIndex"),
        // Which enrollment this run is (#245). Forwarded, not derived: it is the
        // send-claim namespace for every step, so a subscriber who leaves and
        // re-subscribes gets the sequence again instead of finding every claim
        // burned by their first run (#207, one automation over). The handler
        // echoes it back — always as a string, never null — so the loop keeps it.
        enrollmentId: JsonPath.stringAt("$.enrollmentId"),
      }),
      outputPath: "$.Payload",
    });
    // A transient Lambda failure — throttle, cold-start timeout, a blip — used to
    // abort the whole execution, dropping that subscriber out of the sequence
    // mid-way with nothing to show it happened (#201). Retried with backoff, and
    // a genuinely permanent failure ends in an explicit Fail state so it appears
    // as a failed execution rather than a quiet Succeed.
    runStep.addRetry({
      errors: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
        "States.TaskFailed",
      ],
      interval: Duration.seconds(5),
      maxAttempts: 4,
      backoffRate: 2,
    });
    const failed = new Fail(this, "DripFailed", {
      cause: "drip step failed after retries",
      error: "DripStepError",
    });
    runStep.addCatch(failed, { resultPath: "$.error" });

    const done = new Succeed(this, "DripDone");
    runStep.next(
      new Choice(this, "DripMore")
        .when(Condition.booleanEquals("$.done", true), done)
        .otherwise(waitStep.next(runStep)),
    );
    const dripStateMachine = new StateMachine(this, "DripStateMachine", {
      // Starts at the WAIT, not the step (#201). Beginning at `runStep` fired
      // step 0 the instant someone enrolled, so a sequence whose first step is
      // "three days after signup" sent it immediately — the one step whose
      // timing an onboarding drip most depends on. The starter supplies
      // `nextStepIndex` and `nextWaitSeconds`; a zero wait is a no-op, so a
      // genuinely immediate first step still behaves as before.
      definitionBody: DefinitionBody.fromChainable(waitStep),
      // A drip is measured in weeks and an onboarding or win-back sequence can
      // run for months. 30 days silently truncated any of those mid-sequence.
      // One year is the Step Functions Standard maximum.
      timeout: Duration.days(365),
    });
    table.grantReadWriteData(dripStepFn);
    new CfnOutput(this, "DripStateMachineArn", { value: dripStateMachine.stateMachineArn });

    // ---- who may START a drip execution (§4.6, #245) ----
    // The machine used to have exactly ONE consumer — the CfnOutput above. No
    // Lambda knew the ARN and no role held states:StartExecution, so the whole
    // drip feature was provisioned and unreachable.
    //
    // Two functions, and only two. `confirmFn` for the signup trigger (the double
    // opt-in is what enrollment is gated on) and `adminApiFn` for the manual one.
    // NOT `dripStepFn`, which is the machine's target rather than a starter — a
    // step able to start executions is a step able to start itself. NOT
    // `reengagementFn`, whose sweep sends directly through SES on its own
    // EventBridge rule and never touches this machine. NOT the signup functions:
    // a pending subscription is not consent.
    //
    // The env var and the grant are set together, per function, deliberately.
    // Putting the ARN in `apiEnv` would hand it to twenty-one functions across
    // four services while granting IAM to none — configuration that LOOKS
    // complete, which is worse than an obvious absence. (It would also need
    // `Lazy`, since `apiEnv` is built 300 lines before this machine exists.)
    //
    // `addEnvironment` rather than the `fn(...)` env argument because `confirmFn`
    // is created before the state machine and `fn` COPIES the env object it is
    // handed — there is no adding to it afterwards.
    confirmFn.addEnvironment("DRIP_STATE_MACHINE_ARN", dripStateMachine.stateMachineArn);
    dripStateMachine.grantStartExecution(confirmFn);
    // ...and DescribeExecution on this machine's executions only, which is what
    // lets the starter tell the two meanings of `ExecutionAlreadyExists` apart: a
    // running (or completed) execution for the same enrollment is a subscriber
    // clicking twice, but a CLOSED execution that ended in failure means the
    // enrollment delivered nothing and — since Step Functions retains the name for
    // 90 days — cannot be started again. Without this the starter can only guess,
    // and it guesses "already enrolled".
    dripStateMachine.grantExecution(confirmFn, "states:DescribeExecution");

    // ---- scheduling (EventBridge Scheduler, §4.6) ----
    const scheduleGroupName = `addressium-${props.stage}`;
    new CfnScheduleGroup(this, "ScheduleGroup", { name: scheduleGroupName });
    // Role EventBridge Scheduler assumes to hit its targets.
    const schedulerRole = new Role(this, "SchedulerRole", {
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
    });
    sendQueue.grantSendMessages(schedulerRole); // one-off schedules -> queue
    launchFn.grantInvoke(schedulerRole); // recurring schedules -> launch

    const schedEnv = {
      ...apiEnv,
      SEND_QUEUE_URL: sendQueue.queueUrl,
      SEND_QUEUE_ARN: sendQueue.queueArn,
      SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
      SCHEDULER_GROUP: scheduleGroupName,
      LAUNCH_FN_ARN: launchFn.functionArn,
    };
    const scheduleFn = fn("ScheduleFn", apiEntry, "scheduleCampaignHandler", schedEnv);
    // Only CreateSchedule is needed — pause/archive never delete schedules (§4.6),
    // they flip the lifecycle record the launch/sender handlers gate on.
    scheduleFn.addToRolePolicy(
      new PolicyStatement({ actions: ["scheduler:CreateSchedule"], resources: ["*"] }),
    );
    scheduleFn.addToRolePolicy(
      new PolicyStatement({ actions: ["iam:PassRole"], resources: [schedulerRole.roleArn] }),
    );
    // Admin actions append to the WORM audit log (put-only; Object Lock blocks
    // overwrite/delete). grantPut avoids handing out s3:DeleteObject.
    auditBucket.grantPut(scheduleFn);

    // ---- permissions ----
    for (const f of [
      signupFn,
      signupBatchFn,
      confirmFn,
      unsubscribeFn,
      entitlementFn,
      identityFn,
      scheduleFn,
      senderFn,
      eventsFn,
      launchFn,
    ]) {
      table.grantReadWriteData(f);
    }
    confirmSecret.grantRead(signupFn);
    confirmSecret.grantRead(signupBatchFn);
    confirmSecret.grantRead(confirmFn);
    confirmSecret.grantRead(unsubscribeFn);
    confirmSecret.grantRead(senderFn); // signs the List-Unsubscribe token (#178)
    webhookSecret.grantRead(entitlementFn);
    webhookSecret.grantRead(identityFn);
    // grantPut + grantRead, NOT grantReadWrite (#202). `grantReadWrite` includes
    // `s3:DeleteObject*`, and that wildcard matches `DeleteObjectVersion` — so
    // versioning did NOT protect the evidentiary send archive from a compromised
    // or buggy sender, which is the one thing versioning was there to do.
    archiveBucket.grantPut(senderFn);
    archiveBucket.grantRead(senderFn);
    // kms:Sign is scoped by the addressium key-tag condition and ses:SendEmail to
    // this account's SES identities/config-sets (#93). Per-org signing keys are
    // created by provisioning at runtime and tagged app=addressium, so the tag
    // condition covers them without enumerating ARNs here (§4.11).

    // ---- wiring ----
    // The SPAs are served from their own CloudFront origins, so every call is
    // cross-origin. Without this, the admin console's authorization +
    // content-type headers force a preflight that fails and NO browser request
    // to this API succeeds (#189).
    const api = new HttpApi(this, "HttpApi", {
      corsPreflight: {
        allowOrigins: [adminOrigin, publicOrigin],
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
        maxAge: Duration.hours(1),
      },
    });
    api.addRoutes({
      path: "/signup",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("SignupInt", signupFn),
    });
    api.addRoutes({
      path: "/signup/batch",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("SignupBatchInt", signupBatchFn),
    });
    // Public, unauthenticated: reports only release + schema version, never
    // config or secrets. Lets an operator confirm an upgrade landed without
    // reading CloudFormation, and the upgrade rehearsal asserts on it (#213).
    const versionFn = fn("VersionFn", apiEntry, "versionHandler", apiEnv);
    table.grantReadData(versionFn);
    api.addRoutes({
      path: "/version",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("VersionInt", versionFn),
    });

    api.addRoutes({
      path: "/confirm",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("ConfirmInt", confirmFn),
    });
    // The preference centre (#74). Its own function with its own reserved
    // concurrency, for the same reason unsubscribe has one: a signup flood must
    // not starve the surface people use to LEAVE.
    const preferencesFn = fn("PreferencesFn", apiEntry, "preferencesHandler", {
      ...apiEnv,
      PREFERENCES_URL_BASE: preferencesUrlBase,
    });
    table.grantReadWriteData(preferencesFn);
    confirmSecret.grantRead(preferencesFn);
    reservePublic(preferencesFn, 20);
    const preferenceRequestFn = fn("PreferenceRequestFn", apiEntry, "preferenceRequestHandler", {
      ...apiEnv,
      PREFERENCES_URL_BASE: preferencesUrlBase,
    });
    table.grantReadData(preferenceRequestFn);
    confirmSecret.grantRead(preferenceRequestFn);
    preferenceRequestFn.addToRolePolicy(sesSendScoped());
    reservePublic(preferenceRequestFn, 10);
    const prefInt = new HttpLambdaIntegration("PreferencesInt", preferencesFn);
    api.addRoutes({ path: "/preferences", methods: [HttpMethod.GET, HttpMethod.POST], integration: prefInt });
    api.addRoutes({
      path: "/preferences/request",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("PreferenceRequestInt", preferenceRequestFn),
    });
    api.addRoutes({
      path: "/unsubscribe",
      // GET as well as POST (#234). POST is the machine path a mailbox provider
      // uses for RFC 8058 one-click; GET is what a human gets when they click
      // the visible "Unsubscribe" link in the message body, which is the SAME
      // url. POST-only meant that link answered 405 — the header worked and the
      // link everybody actually clicks did not.
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration: new HttpLambdaIntegration("UnsubscribeInt", unsubscribeFn),
    });
    // Admin routes require a valid admin-pool JWT; the handler then enforces
    // role + org scope from the claims (§4.12).
    const adminAuth = new HttpUserPoolAuthorizer("AdminAuthorizer", adminPool, {
      userPoolClients: [adminClient],
    });
    api.addRoutes({
      path: "/campaigns/schedule",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("ScheduleInt", scheduleFn),
      authorizer: adminAuth,
    });
    api.addRoutes({
      path: "/webhooks/entitlement",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("EntitlementInt", entitlementFn),
    });
    api.addRoutes({
      path: "/webhooks/identity",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("IdentityInt", identityFn),
    });

    // ---- admin CRUD + branding + presentation + AI config (§4.1, #18/#31/#32/#33) ----
    // Each handler is a small Lambda; admin routes sit behind the JWT authorizer,
    // then the handler enforces role + org scope from the claims.
    // ONE function serves every authenticated route, dispatching internally on
    // API Gateway's routeKey. Previously each of these 27 routes got its own
    // Lambda — 27 copies of the same bundle, each with a cold start, a log
    // group and an IAM role, for a data model that never changes (#213).
    //
    // Routes stay registered INDIVIDUALLY rather than as a catch-all: the JWT
    // authorizer attaches per route, so a `$default` would have erased the
    // public/authenticated boundary. This keeps the boundary and drops the
    // duplication.
    const adminApiFn = fn("AdminApiFn", apiEntry, "adminRouter", {
      ...apiEnv,
      // Team management (#226) acts on OUR admin pool, not the operator's
      // subscriber directory.
      ADMIN_POOL_ID: adminPool.userPoolId,
      // Which engine the SENDER will resolve with (#246) — not a grant, just the
      // fact. `segmentsHandler` uses it to refuse a predicate that engine cannot
      // resolve, so an operator learns at save time rather than mid-campaign.
      // Deliberately the same `segmentEngine` value the sender's wiring reads.
      SEGMENT_ENGINE: segmentEngine,
      // Scopes the health check to THIS deployment's alarms; every alarm this
      // stack creates is named with the construct id prefix.
      ALARM_PREFIX: `${Stack.of(this).stackName}-`,
      // Resuming a paused one-off re-enqueues the send that fired while it was
      // paused (#179). Without the queue, resume would 500 at the last step
      // having already flipped the record to active — the worst place to fail.
      SEND_QUEUE_URL: sendQueue.queueUrl,
      // An erasure report quotes a lake retention window only when there IS a
      // lake (#164). Claiming one on a deployment with analytics off would be a
      // number the operator cannot check against any bucket.
      ANALYTICS_ENABLED: String(enableAnalytics),
      ANALYTICS_EVENT_RETENTION_DAYS: String(analyticsEventRetentionDays),
      // Manual drip enrollment (#245). This function is created AFTER the state
      // machine, so it can take the ARN directly rather than through
      // `addEnvironment` — the grant is beside its other grants below.
      DRIP_STATE_MACHINE_ARN: dripStateMachine.stateMachineArn,
    });
    table.grantReadWriteData(adminApiFn);
    sendQueue.grantSendMessages(adminApiFn);
    customerSyncQueue.grantSendMessages(adminApiFn);
    // Customer-sync configuration stores the endpoint's secret in Secrets
    // Manager; only the reference is written to the organization record.
    //
    // Split in two because CreateSecret cannot be scoped by resource — the ARN
    // does not exist yet when the call is made, so `resources` has nothing to
    // match and IAM requires "*". The name is constrained instead, with the
    // same `addressium/*` prefix `orgSecretsScoped()` uses for reads.
    //
    // The write actions ARE scoped to that prefix. Granting PutSecretValue on
    // "*" would have let this function overwrite every secret in the account,
    // including the stack's own confirmation-token and webhook signing keys —
    // and overwriting the confirm signer silently invalidates every
    // outstanding double opt-in link. `saveCustomerSyncSecret` only ever
    // touches `addressium/{orgId}/customer-sync` (services/api/src/index.ts),
    // so nothing outside the prefix was ever used.
    adminApiFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:CreateSecret"],
        resources: ["*"],
        conditions: { StringLike: { "secretsmanager:Name": "addressium/*" } },
      }),
    );
    // A replacement customer-sync secret retains the old key for a tightly
    // bounded HMAC rollover window. Read is confined to the same per-org
    // namespace as every other runtime secret; it never reaches stack secrets.
    adminApiFn.addToRolePolicy(orgSecretsScoped());
    adminApiFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:PutSecretValue", "secretsmanager:TagResource"],
        resources: [
          Stack.of(this).formatArn({
            service: "secretsmanager",
            resource: "secret",
            resourceName: "addressium/*",
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // Three suppression-list actions, two different risk shapes (#240, #247).
    //
    // ListSuppressedDestinations — POST /orgs/{org}/import/suppression (#240):
    // the migration importer needs to know what SES already refuses to mail,
    // and nothing more.
    //
    // GetSuppressedDestination / PutSuppressedDestination — the per-address
    // console actions (#247): GET /orgs/{org}/suppression/check (the console
    // equivalent of `aws sesv2 get-suppressed-destination`) and the live mirror
    // write inside subscriberSuppressHandler when a manual suppression is
    // scoped GLOBAL. Deliberately NOT DeleteSuppressedDestination or a BULK
    // write path — writing our WHOLE list into the operator's account list
    // would change how their account behaves for every sender using it,
    // including whatever they have not migrated yet (see ses-suppression.ts).
    // A single deliberate write, one operator acting on one address they are
    // looking at right now, audited on the way in, is a different risk shape
    // entirely — closer to what an operator could already do by hand in the SES
    // console than to a bulk import.
    //
    // Resource "*" for all three, because that is the only form SES accepts —
    // the account suppression list is an account-level singleton with no ARN to
    // scope to. The narrowness here comes from which three actions are granted,
    // not the resource.
    adminApiFn.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "ses:ListSuppressedDestinations",
          "ses:GetSuppressedDestination",
          "ses:PutSuppressedDestination",
        ],
        resources: ["*"],
      }),
    );
    // The SES sending-identity readout (#285) — GET /orgs/{org}/sending-identity,
    // and the same grant the Settings screen's verification table needs. Two
    // actions, both READS, and deliberately not folded into the statement above:
    // that one is about the suppression list, this one is about whether the org
    // can send at all, and a reader should be able to tell which route each
    // action serves.
    //
    // Nothing here creates or changes an identity. `CreateEmailIdentity`,
    // `PutEmailIdentityMailFromAttributes` and the configuration-set writes stay
    // on `provisioningFn`, which is not internet-facing in the way this router
    // is — the router answers every authenticated console request, so a write
    // grant here would be reachable from ~50 routes instead of one.
    //
    // `GetEmailIdentity` is scoped to identities in this account and region, the
    // same shape `tokensFn` uses for its KMS grant, rather than "*". Every
    // identity this reads was created by our own provisioning function, so there
    // is no reason for the router to be able to interrogate an ARN outside it.
    adminApiFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["ses:GetEmailIdentity"],
        resources: [
          Stack.of(this).formatArn({ service: "ses", resource: "identity", resourceName: "*" }),
        ],
      }),
    );
    // `ses:GetAccount` is the sandbox check — `ProductionAccessEnabled`, the one
    // fact that explains a valid subscriber address being refused on the public
    // signup page. Resource "*" by necessity, for the reason already written out
    // above the suppression statement: account-level settings are a singleton
    // with no ARN to scope to. The narrowness is the single read action, not the
    // resource.
    adminApiFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["ses:GetAccount"],
        resources: ["*"],
      }),
    );
    // POST /drip-sequences/enroll. Paired with the env var above: a function that
    // can reach the starter but cannot call it fails at runtime, inside a route.
    dripStateMachine.grantStartExecution(adminApiFn);
    // Same pair as `confirmFn`: reading the status of the execution that already
    // owns a name is how a duplicate enrollment is told apart from one that ran
    // and failed. Scoped to this machine's executions.
    dripStateMachine.grantExecution(adminApiFn, "states:DescribeExecution");
    // Scoped to this pool only, and to the four actions team management needs —
    // not cognito-idp:* on the account. The router is internet-facing, so a
    // wildcard here would let one compromised route reach every pool in the
    // account, including the operator's subscriber directories.
    // DescribeAlarms takes no resource-level condition, so this is "*" by
    // necessity — but it is READ-ONLY on alarm state, and the handler returns a
    // verdict rather than the alarm list, so nothing about the account's alarms
    // reaches the browser (#229).
    // The admin router is where privileged actions actually happen (#191):
    // team changes, erasure, bulk export, alert thresholds. grantPut only — an
    // audit log its own writer can delete from is not an audit log.
    auditBucket.grantPut(adminApiFn);
    // Read, so the console can answer "who exported subscriber data on the
    // 14th?" without an AWS console login (#191). Read and Put only — never
    // Delete: an audit log its own writer can remove from is not an audit log,
    // and Object Lock is the second line rather than the first.
    auditBucket.grantRead(adminApiFn);
    // Write the export, then presign a GET of it. Read is needed because a
    // presigned URL can only carry permissions the signer itself holds — a
    // write-only role would sign a URL that 403s. Scoped to this bucket, whose
    // lifecycle deletes everything in it after seven days (#224).
    exportBucket.grantPut(adminApiFn);
    exportBucket.grantRead(adminApiFn);
    // The async import job (#242). Fifteen minutes and more memory than a route
    // gets, because that is the point: the work that used to have to finish
    // inside a 29-second integration timeout now does not.
    const importerFn = fn("ImporterFn", svc("services/importer/src/index.ts"), "handler", {
      ...apiEnv,
      IMPORT_BUCKET: importBucket.bucketName,
    });
    (importerFn.node.defaultChild as CfnFunction).addPropertyOverride("Timeout", 900);
    (importerFn.node.defaultChild as CfnFunction).addPropertyOverride("MemorySize", 1024);
    table.grantReadWriteData(importerFn);
    // READ only: the job consumes the object the console uploaded and has no
    // reason to write one. The presigned PUT is minted by the API, which holds
    // the write grant.
    importBucket.grantRead(importerFn);
    importBucket.grantPut(adminApiFn); // presign the upload
    adminApiFn.addEnvironment("IMPORT_BUCKET", importBucket.bucketName);
    adminApiFn.addEnvironment("IMPORTER_FN", importerFn.functionName);
    importerFn.grantInvoke(adminApiFn);
    adminApiFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudwatch:DescribeAlarms"],
        resources: ["*"],
      }),
    );
    adminApiFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "cognito-idp:ListUsers",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminDisableUser",
        ],
        resources: [adminPool.userPoolArn],
      }),
    );
    // scopePermissionToRoute:false emits ONE api-scoped permission (`*/*/*`)
    // instead of one per route. With the default (true), each of the ~49 admin
    // routes appends its own statement to adminApiFn's resource policy, which
    // overflows Lambda's hard 20,480-byte limit part-way through the create:
    //   "The final policy size (20698) is bigger than the limit (20480)."
    // Nothing is lost by widening it. Every route here shares this one function
    // AND one JWT authorizer (adminAuth), so a caller who can reach any admin
    // route can already reach them all — the per-route ARNs never separated
    // anything. Authorization is the authorizer plus the handler's own RBAC
    // checks, not the resource policy.
    const adminApiInt = new HttpLambdaIntegration("AdminApiInt", adminApiFn, {
      scopePermissionToRoute: false,
    });
    const adminRoute = (_id: string, _handler: string, method: HttpMethod, path: string) => {
      api.addRoutes({
        path,
        methods: [method],
        integration: adminApiInt,
        authorizer: adminAuth,
      });
      return adminApiFn;
    };
    // ---- provisioning + tokens (#198) ----
    // Both services existed in the repo but were NEVER deployed: no Lambda, no
    // route, no IAM. That made "Add organization" impossible (so no org could
    // have a KMS key, SES identity or config set) and left publishers with no
    // JWKS endpoint to verify magic-link tokens against.
    const provisioningFn = fn("ProvisioningFn", svc("services/provisioning/src/index.ts"), "handler", {
      ...apiEnv,
      // Lets provisioning attach the SES event destination (#208) — without it
      // a new org's config set publishes nothing and the event plane is dead.
      SES_EVENTS_TOPIC_ARN: sesEvents.topicArn,
    });
    table.grantReadWriteData(provisioningFn);
    // Org creation is a privileged, audited action (§4.19) — the sink is already
    // in apiEnv as AUDIT_BUCKET; this is the write grant.
    auditBucket.grantPut(provisioningFn);
    provisioningFn.addToRolePolicy(
      new PolicyStatement({
        // Per-org resources are created at runtime, so their ARNs cannot be
        // enumerated here; these are creation calls, which are inherently
        // account-scoped. The KMS key is tagged app=addressium so downstream
        // grants can scope to it.
        actions: [
          "kms:CreateKey",
          "kms:CreateAlias",
          "kms:UpdateAlias",
          "kms:TagResource",
          "ses:CreateConfigurationSet",
          "ses:CreateConfigurationSetEventDestination",
          "ses:UpdateConfigurationSetEventDestination",
          "ses:CreateEmailIdentity",
          "ses:GetEmailIdentity",
          "ses:TagResource",
          // Deliverability (#200): the custom MAIL FROM that puts the envelope
          // sender on the org's own domain so SPF aligns, and SES-side
          // bounce/complaint suppression on the org's configuration set.
          "ses:PutEmailIdentityMailFromAttributes",
          "ses:PutConfigurationSetSuppressionOptions",
          // The dedicated IP pool an operator created is ASSIGNED here (#237).
          // CreateDedicatedIpPool is deliberately absent: a dedicated IP is a
          // standing charge, and provisioning one from a checkbox would bill an
          // operator for infrastructure they did not knowingly ask for.
          "ses:PutConfigurationSetDeliveryOptions",
          // CreateUserPool is deliberately absent: pools are link-only (#18,
          // #226). Provisioning validates the operator's existing pool with
          // DescribeUserPool and never creates one.
          "cognito-idp:DescribeUserPool",
        ],
        resources: ["*"],
      }),
    );
    // Same reasoning as ConfirmFn (#167): creation APIs need a broad resource,
    // so deny the control-plane pool explicitly rather than trusting scope.
    provisioningFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ["cognito-idp:*"],
        resources: [adminPool.userPoolArn],
      }),
    );
    api.addRoutes({
      path: "/orgs",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("ProvisioningInt", provisioningFn),
      authorizer: adminAuth, // handler additionally requires identity:manage
    });
    api.addRoutes({
      path: "/orgs/{org}/identity/rotate-key",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("RotateMagicLinkKeyInt", provisioningFn),
      authorizer: adminAuth,
    });

    // Public JWKS so publisher sites can verify magic-link tokens (§4.10).
    const tokensFn = fn("TokensFn", svc("services/tokens/src/index.ts"), "handler", apiEnv);
    table.grantReadData(tokensFn);
    tokensFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["kms:GetPublicKey"],
        resources: [Stack.of(this).formatArn({ service: "kms", resource: "key", resourceName: "*" })],
      }),
    );
    api.addRoutes({
      path: "/orgs/{org}/.well-known/jwks.json",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("TokensInt", tokensFn),
    });

    // GET /orgs is the console's org switcher; POST /orgs (registered above with
    // its own integration) creates one. Same path, different capability: listing
    // is scoped by the caller's own grant, creating requires identity:manage.
    adminRoute("OrgsListFn", "orgsListHandler", HttpMethod.GET, "/orgs");
    adminRoute("OrgMetaFn", "orgMetaHandler", HttpMethod.GET, "/orgs/{org}");
    adminRoute("SearchFn", "searchHandler", HttpMethod.GET, "/orgs/{org}/search");
    // Read-only identity config for the console's Identity & pools screen. Its
    // own route because the handler gates on identity:manage, not reports:view.
    adminRoute("OrgIdentityFn", "orgIdentityHandler", HttpMethod.GET, "/orgs/{org}/identity");
    // The live SES read (#285): is the domain identity verified, and is the
    // account out of the sandbox. Its own route, and `identity:manage` like its
    // sibling above — the sandbox and the account quota describe the DEPLOYMENT,
    // not this org's numbers, so `reports:view` is the wrong audience. The SES
    // grant it needs is on `adminApiFn` beside the suppression statement.
    adminRoute("SendingIdentityFn", "sendingIdentityHandler", HttpMethod.GET, "/orgs/{org}/sending-identity");
    adminRoute("SetupStateFn", "setupStateHandler", HttpMethod.GET, "/orgs/{org}/setup");
    adminRoute("ListsGetFn", "listsHandler", HttpMethod.GET, "/orgs/{org}/lists");
    adminRoute("ListsPostFn", "listsHandler", HttpMethod.POST, "/lists");
    adminRoute("ListVisFn", "listVisibilityHandler", HttpMethod.POST, "/lists/visibility");
    adminRoute("CampaignsListFn", "campaignsListHandler", HttpMethod.GET, "/orgs/{org}/campaigns");
    adminRoute("CampaignsGetFn", "campaignsHandler", HttpMethod.GET, "/orgs/{org}/campaigns/{id}");
    adminRoute("CampaignContentFn", "campaignContentHandler", HttpMethod.GET, "/orgs/{org}/campaigns/{id}/content");
    adminRoute("CampaignsPostFn", "campaignsHandler", HttpMethod.POST, "/campaigns");
    // Send-schedule lifecycle: list + start/pause/archive (never delete, §4.6).
    adminRoute("SchedulesGetFn", "schedulesListHandler", HttpMethod.GET, "/orgs/{org}/schedules");
    adminRoute("ScheduleLifecycleFn", "scheduleLifecycleHandler", HttpMethod.POST, "/campaigns/lifecycle");
    adminRoute("SendNowFn", "sendNowHandler", HttpMethod.POST, "/campaigns/send-now");
    // Reusable templates (§4.15): list, read one, save.
    adminRoute("TemplatesGetFn", "templatesHandler", HttpMethod.GET, "/orgs/{org}/templates");
    adminRoute("TemplateGetFn", "templatesHandler", HttpMethod.GET, "/orgs/{org}/templates/{id}");
    adminRoute("TemplatesPostFn", "templatesHandler", HttpMethod.POST, "/templates");
    adminRoute("MergeTagsGetFn", "mergeTagsHandler", HttpMethod.GET, "/orgs/{org}/merge-tags");
    adminRoute("MergeTagsPostFn", "mergeTagsHandler", HttpMethod.POST, "/merge-tags");
    adminRoute("MergeTagDeleteFn", "mergeTagDeleteHandler", HttpMethod.POST, "/merge-tags/delete");
    // API keys (#280). All four carry the admin authorizer — `verify` especially:
    // it turns a plaintext key into a yes/no, which unauthenticated would be an
    // oracle to grind candidate keys against. No route in this build is
    // AUTHENTICATED BY an API key; these manage the credentials, and the console
    // still rides Cognito.
    adminRoute("ApiKeysGetFn", "apiKeysHandler", HttpMethod.GET, "/orgs/{org}/api-keys");
    adminRoute("ApiKeysPostFn", "apiKeysHandler", HttpMethod.POST, "/api-keys");
    adminRoute("ApiKeyRevokeFn", "apiKeyRevokeHandler", HttpMethod.POST, "/api-keys/revoke");
    adminRoute("ApiKeyVerifyFn", "apiKeyVerifyHandler", HttpMethod.POST, "/api-keys/verify");
    // Recurring campaign series (§4.6): list, read one, create/edit. No delete —
    // editions and series-bound ad fills reference a series by id.
    adminRoute("SeriesGetFn", "seriesHandler", HttpMethod.GET, "/orgs/{org}/series");
    adminRoute("SeriesGetOneFn", "seriesHandler", HttpMethod.GET, "/orgs/{org}/series/{id}");
    adminRoute("SeriesPostFn", "seriesHandler", HttpMethod.POST, "/series");
    adminRoute("FeedsGetFn", "feedsHandler", HttpMethod.GET, "/orgs/{org}/feeds");
    adminRoute("FeedsPostFn", "feedsHandler", HttpMethod.POST, "/feeds");
    adminRoute("SegmentsGetFn", "segmentsHandler", HttpMethod.GET, "/orgs/{org}/segments");
    adminRoute("SegmentsPostFn", "segmentsHandler", HttpMethod.POST, "/segments");
    adminRoute("SegmentMembersGetFn", "segmentMembersHandler", HttpMethod.GET, "/orgs/{org}/segments/{segment}/members");
    adminRoute("SegmentMembersPostFn", "segmentMembersHandler", HttpMethod.POST, "/segments/members");
    // Drip sequences (#104): list + create/edit, and hand-enrollment (#245).
    adminRoute("DripSeqGetFn", "dripSequencesHandler", HttpMethod.GET, "/orgs/{org}/drip-sequences");
    adminRoute("DripSeqPostFn", "dripSequencesHandler", HttpMethod.POST, "/drip-sequences");
    adminRoute("DripEnrollFn", "dripEnrollHandler", HttpMethod.POST, "/drip-sequences/enroll");
    adminRoute("SuppressFn", "subscriberSuppressHandler", HttpMethod.POST, "/subscribers/suppress");
    adminRoute("SubUnsubFn", "subscriberUnsubscribeHandler", HttpMethod.POST, "/subscribers/unsubscribe");
    // Operator-side subscriber management (#102): list/search, suppression list,
    // and lift-suppression.
    adminRoute("SubscribersListFn", "subscribersListHandler", HttpMethod.GET, "/orgs/{org}/subscribers");
    adminRoute("SubscriberTimelineFn", "subscriberTimelineHandler", HttpMethod.GET, "/orgs/{org}/subscribers/{sub}/timeline");
    adminRoute("SubscriberDetailFn", "subscriberDetailHandler", HttpMethod.GET, "/orgs/{org}/subscribers/{sub}");
    adminRoute("SubscriberAttrsFn", "subscriberAttributesHandler", HttpMethod.POST, "/subscribers/attributes");
    adminRoute("SubscriptionStatusFn", "subscriptionStatusHandler", HttpMethod.POST, "/subscribers/subscription");
    adminRoute("SuppressionsListFn", "suppressionsListHandler", HttpMethod.GET, "/orgs/{org}/suppressions");
    adminRoute("SuppressionCheckFn", "suppressionCheckHandler", HttpMethod.GET, "/orgs/{org}/suppression/check");
    adminRoute("UnsuppressFn", "subscriberUnsuppressHandler", HttpMethod.POST, "/subscribers/unsuppress");
    // Subscriber migration (#100) + GDPR/CCPA data-subject requests (#101).
    adminRoute("ImportFn", "importHandler", HttpMethod.POST, "/orgs/{org}/import");
    // System health (#229) — a single derived verdict for the console.
    adminRoute("HealthFn", "healthHandler", HttpMethod.GET, "/orgs/{org}/health");
    // Team management (#226) — deployment-wide members, gated on team:manage.
    adminRoute("TeamGetFn", "teamHandler", HttpMethod.GET, "/orgs/{org}/team");
    adminRoute("TeamPostFn", "teamHandler", HttpMethod.POST, "/team");
    // Bulk portability (#224) — the whole org, re-importable.
    adminRoute("ExportFn", "exportHandler", HttpMethod.GET, "/orgs/{org}/export");
    // Field mapper (#216): preview writes nothing; mapped runs the import.
    adminRoute("ImportPreviewFn", "importPreviewHandler", HttpMethod.POST, "/orgs/{org}/import/preview");
    adminRoute("ImportMappedFn", "importMappedHandler", HttpMethod.POST, "/orgs/{org}/import/mapped");
    adminRoute("ImportSuppressionFn", "importSuppressionHandler", HttpMethod.POST, "/orgs/{org}/import/suppression");
    adminRoute("ImportSegmentFn", "importSegmentHandler", HttpMethod.POST, "/orgs/{org}/import/segment");
    // Async import (#242): presign an upload, then run it as a job.
    adminRoute("ImportUploadUrlFn", "importUploadUrlHandler", HttpMethod.POST, "/orgs/{org}/import/upload-url");
    adminRoute("ImportUploadPreviewFn", "importUploadPreviewHandler", HttpMethod.POST, "/orgs/{org}/import/upload-preview");
    adminRoute("ImportAsyncFn", "importAsyncHandler", HttpMethod.POST, "/orgs/{org}/import/async");
    adminRoute("ImportMappingsGetFn", "importMappingsHandler", HttpMethod.GET, "/orgs/{org}/import/mappings");
    adminRoute("ImportMappingsPostFn", "importMappingsHandler", HttpMethod.POST, "/orgs/{org}/import/mappings");
    // Import history (#223) — which run wrote which memberships, so a bad file
    // can be found again rather than reconstructed from timestamps.
    adminRoute("ImportBatchesFn", "importBatchesHandler", HttpMethod.GET, "/orgs/{org}/import/batches");
    // Audit log READ (#191). The writes were wired in #191's first half; without
    // this the record existed and nobody could see it.
    adminRoute("AuditReadFn", "auditReadHandler", HttpMethod.GET, "/orgs/{org}/audit");
    adminRoute("PrivacyFn", "privacyHandler", HttpMethod.POST, "/privacy");
    adminRoute("BrandingPostFn", "brandingHandler", HttpMethod.POST, "/orgs/branding");
    adminRoute("SettingsPostFn", "settingsHandler", HttpMethod.POST, "/orgs/settings");
    adminRoute("CustomerSyncGetFn", "customerSyncHandler", HttpMethod.GET, "/orgs/{org}/customer-sync");
    adminRoute("CustomerSyncPostFn", "customerSyncHandler", HttpMethod.POST, "/orgs/customer-sync");
    adminRoute("ReengagementGetFn", "reengagementHandler", HttpMethod.GET, "/orgs/{org}/reengagement");
    adminRoute("ReengagementPostFn", "reengagementHandler", HttpMethod.POST, "/orgs/reengagement");
    // Deliverability thresholds — these drive the auto-halt (#217).
    adminRoute("AlertConfigGetFn", "alertConfigHandler", HttpMethod.GET, "/orgs/{org}/alerts");
    adminRoute("AlertConfigPostFn", "alertConfigHandler", HttpMethod.POST, "/orgs/alerts");
    adminRoute("PresentationFn", "listPresentationHandler", HttpMethod.POST, "/lists/presentation");

    // Public (no auth): branding + list view the subscriber site reads.
    const publicBrandingFn = fn("PublicBrandingFn", apiEntry, "brandingHandler", apiEnv);
    table.grantReadData(publicBrandingFn);
    reservePublic(publicBrandingFn);
    api.addRoutes({
      path: "/orgs/{org}/branding",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("PublicBrandingInt", publicBrandingFn),
    });
    // The browse page of the public subscriber site (#124). It was calling the
    // ADMIN /orgs/{org}/lists, which sits behind the console authorizer, so the
    // front door of the whole public site could only ever have returned 401.
    const publicDirectoryFn = fn("PublicDirectoryFn", apiEntry, "publicDirectoryHandler", apiEnv);
    table.grantReadData(publicDirectoryFn);
    reservePublic(publicDirectoryFn);
    api.addRoutes({
      path: "/orgs/{org}/directory",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("PublicDirectoryInt", publicDirectoryFn),
    });
    const publicListFn = fn("PublicListFn", apiEntry, "publicListHandler", apiEnv);
    table.grantReadData(publicListFn);
    reservePublic(publicListFn);
    api.addRoutes({
      path: "/orgs/{org}/lists/{list}/public",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("PublicListInt", publicListFn),
    });

    // Public archive of past editions (#310). Its OWN function, not another
    // route on the admin one: the unauthenticated surface stays exactly one
    // handler, so nothing the admin function can do is reachable from here even
    // if a route were misconfigured later.
    //
    // Deliberately not a relaxation of `archiveHandler`, which is gated on
    // `reports:view` and decorates the body with per-link click counts —
    // commercial analytics that must not be published.
    // ---- machine API (#291) ----
    //
    // API-key authenticated, on its own `/v1` prefix, with NO JWT authorizer.
    // That omission is the design, not an oversight: an API Gateway authorizer
    // caches per identity source, so a revoked key would keep working until the
    // cache expired. Authentication happens inside the handler, against the
    // stored key, every request — which is what makes "revoked keys fail" mean
    // immediately.
    //
    // Its own Lambda, so a machine caller's traffic cannot exhaust the
    // console's reserved concurrency (or the reverse), and so its IAM is scoped
    // to what these three routes actually touch.
    const machineApiFn = fn("MachineApiFn", apiEntry, "machineRouter", apiEnv);
    table.grantReadWriteData(machineApiFn);
    reservePublic(machineApiFn);
    const machineInt = new HttpLambdaIntegration("MachineApiInt", machineApiFn, {
      scopePermissionToRoute: false,
    });
    for (const [method, path] of [
      [HttpMethod.GET, "/v1/orgs/{org}/subscribers/{email}"],
      [HttpMethod.POST, "/v1/orgs/{org}/suppression"],
      [HttpMethod.GET, "/v1/orgs/{org}/campaigns"],
    ] as [HttpMethod, string][]) {
      api.addRoutes({ path, methods: [method], integration: machineInt });
    }

    const publicArchiveFn = fn("PublicArchiveFn", apiEntry, "publicArchiveHandler", {
      ...apiEnv,
      ARCHIVE_BUCKET: archiveBucket.bucketName,
    });
    table.grantReadData(publicArchiveFn);
    archiveBucket.grantRead(publicArchiveFn);
    reservePublic(publicArchiveFn);
    api.addRoutes({
      // No `authorizer` — that is the point. The handler enforces the list's own
      // `publicArchive` opt-in instead.
      path: "/public/orgs/{org}/editions/{campaign}",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("PublicArchiveInt", publicArchiveFn),
    });

    // ---- reporting (report, usage, AI analysis) — §4.8, #13/#26/#32 ----
    const reportingEntry = svc("services/reporting/src/index.ts");
    const reportFn = fn("ReportFn", reportingEntry, "handler", apiEnv);
    table.grantReadData(reportFn);
    const trendsFn = fn("TrendsFn", reportingEntry, "trendsHandler", apiEnv);
    table.grantReadData(trendsFn);
    const seriesReportFn = fn("SeriesReportFn", reportingEntry, "seriesReportHandler", apiEnv);
    table.grantReadData(seriesReportFn);
    const archiveFn = fn("ArchiveFn", reportingEntry, "archiveHandler", { ...apiEnv, ARCHIVE_BUCKET: archiveBucket.bucketName });
    table.grantReadData(archiveFn);
    archiveBucket.grantRead(archiveFn);

    api.addRoutes({
      path: "/orgs/{org}/campaigns/{campaign}/report",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("ReportInt", reportFn),
      authorizer: adminAuth,
    });
    api.addRoutes({
      path: "/orgs/{org}/analytics/trends",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("TrendsInt", trendsFn),
      authorizer: adminAuth,
    });
    api.addRoutes({
      path: "/orgs/{org}/series/{series}/report",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("SeriesReportInt", seriesReportFn),
      authorizer: adminAuth,
    });
    api.addRoutes({
      path: "/orgs/{org}/campaigns/{campaign}/archive",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("ArchiveInt", archiveFn),
      authorizer: adminAuth,
    });
    // Usage & cost (§11) — surfaced on the admin Usage screen.
    const usageFn = fn("UsageFn", reportingEntry, "usageHandler", apiEnv);
    table.grantReadData(usageFn);
    const usageInt = new HttpLambdaIntegration("UsageInt", usageFn);
    api.addRoutes({ path: "/orgs/{org}/usage", methods: [HttpMethod.GET], integration: usageInt, authorizer: adminAuth });
    api.addRoutes({ path: "/orgs/{org}/usage/{period}", methods: [HttpMethod.GET], integration: usageInt, authorizer: adminAuth });

    // Metering writers (#199). The Usage screen read a permanent $0 because
    // NOTHING wrote a usage record — `usageIngestHandler` was wired to no route
    // and no schedule, so the GETs above always answered `null`.
    //
    // Two writers, split by what each can actually know. The scheduled one fills
    // email volume from our own event log; the invoke-only one takes the AWS-side
    // figures (storage, dedicated IPs, Athena scan) from a job in the operator's
    // account that can read Cost Explorer. They merge rather than overwrite, so
    // neither erases the other's half.
    const usageMeterFn = fn("UsageMeterFn", reportingEntry, "usageMeterHandler", apiEnv);
    table.grantReadWriteData(usageMeterFn);
    new Rule(this, "UsageMeterSchedule", {
      // 04:00 UTC daily — after the 03:00 analytics export, and the current
      // period accrues, so this month's figure is current rather than blank
      // until the month ends.
      schedule: Schedule.cron({ minute: "0", hour: "4" }),
      targets: [new LambdaFunction(usageMeterFn)],
    });
    const usageIngestFn = fn("UsageIngestFn", reportingEntry, "usageIngestHandler", apiEnv);
    table.grantReadWriteData(usageIngestFn);
    new CfnOutput(this, "UsageIngestFunctionName", {
      value: usageIngestFn.functionName,
      description:
        "Invoke with {orgId, period, storageBytes, dedicatedIps, athenaBytesScanned} to feed AWS-side usage (#199)",
    });

    // reportBatchItemFailures is required for the handler's `batchItemFailures`
    // return value to mean anything. Without it one throw failed the WHOLE batch
    // and redelivered the other 9 messages — re-sending already-delivered mail,
    // up to maxReceiveCount times (#177).
    //
    // maxConcurrency bounds how many senders run at once. That alone is not the
    // rate limit (#176): the TokenBucket is per-INVOCATION, so N concurrent
    // senders each pacing to the full account rate produce N × the quota. The
    // sender divides its rate by this number, which is why the value is passed
    // to it as env rather than living in two places that can drift.
    senderFn.addEventSource(
      new SqsEventSource(sendQueue, {
        // ONE slice per invocation. The handler loops records serially, so a
        // batch of ten put ten slices behind one timeout — the slowest took the
        // other nine down with it and all ten redelivered. A slice is already
        // the unit of parallelism; batching them here only removes it.
        batchSize: 1,
        reportBatchItemFailures: true,
        maxConcurrency: SENDER_MAX_CONCURRENCY,
      }),
    );

    // Created HERE, before the alarm loop, so they are alarmed like every other
    // handler (#186). They used to be built at the very bottom of the stack,
    // after both the alarm loop and the dashboard — so neither analytics Lambda
    // had an error or throttle alarm, and a transform that failed on every
    // record diverted the entire fact tier to `events-errors/` with nobody paged.
    let analyticsTransformFn: NodejsFunction | undefined;
    let analyticsSnapshotFn: NodejsFunction | undefined;
    let analyticsReplayFn: NodejsFunction | undefined;
    if (enableAnalytics && analyticsStream) {
      analyticsTransformFn = fn("AnalyticsExportFn", svc("services/analytics-export/src/index.ts"), "handler");
      analyticsSnapshotFn = fn("AnalyticsSnapshotFn", svc("services/analytics-export/src/index.ts"), "exportHandler", {
        TABLE_ARN: table.tableArn,
        ANALYTICS_BUCKET: analyticsBucket.bucketName,
      });
      // Replays whatever Firehose parked under `events-errors/` (#186). Nothing
      // reprocessed that prefix, so a transform bug was permanent data loss
      // dressed up as a temporary diversion.
      analyticsReplayFn = fn("AnalyticsReplayFn", svc("services/analytics-export/src/index.ts"), "replayHandler", {
        ANALYTICS_BUCKET: analyticsBucket.bucketName,
      });
      analyticsBucket.grantReadWrite(analyticsReplayFn);
    }

    // ---- infra alarms (#92) — page ops on a stuck/failing send pipeline ----
    const alarmAction = new SnsAction(opsAlerts);
    // Every alarm, kept so the dashboard and the health endpoint describe the
    // same set the alarms themselves use — three hand-maintained lists would
    // drift, and a health badge that watches a stale subset is worse than none.
    const allAlarms: Alarm[] = [];
    const alarm = (id: string, a: Alarm) => {
      a.addAlarmAction(alarmAction);
      allAlarms.push(a);
      return a;
    };
    // Anything in the DLQ means messages exhausted their retries — investigate.
    alarm("SendDlqNotEmptyAlarm", new Alarm(this, "SendDlqNotEmptyAlarm", {
      metric: sendDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: messages in the send dead-letter queue",
    }));
    // Oldest message age climbing = the sender isn't draining the queue.
    alarm("SendQueueAgeAlarm", new Alarm(this, "SendQueueAgeAlarm", {
      metric: sendQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5) }),
      threshold: Duration.minutes(15).toSeconds(),
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: send queue backing up (oldest message > 15m)",
    }));
    // The event plane gets the same pair as the send pipeline (#218). Without
    // these, a DLQ filling with undeliverable bounces is invisible — and a
    // bounce that never reaches suppression is an address we keep mailing.
    alarm("EventsDlqNotEmptyAlarm", new Alarm(this, "EventsDlqNotEmptyAlarm", {
      metric: eventsDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: messages in the engagement-event dead-letter queue",
    }));
    alarm("EventsQueueAgeAlarm", new Alarm(this, "EventsQueueAgeAlarm", {
      metric: eventsQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5) }),
      threshold: Duration.minutes(15).toSeconds(),
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: event queue backing up (oldest message > 15m)",
    }));
    alarm("CustomerSyncDlqNotEmptyAlarm", new Alarm(this, "CustomerSyncDlqNotEmptyAlarm", {
      metric: customerSyncDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: customer-record updates in the dead-letter queue",
    }));
    alarm("CustomerSyncQueueAgeAlarm", new Alarm(this, "CustomerSyncQueueAgeAlarm", {
      metric: customerSyncQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5) }),
      threshold: Duration.minutes(15).toSeconds(),
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: customer-record update queue backing up (oldest message > 15m)",
    }));
    // Lambda errors + throttles across the critical send path AND the public
    // surface. Previously only the three send-path functions were alarmed, so a
    // failing signup, confirm, unsubscribe, webhook, or SES-event handler was
    // completely silent — including bounce/complaint processing (#187).
    for (const [label, f] of [
      ["Sender", senderFn],
      ["Launch", launchFn],
      ["DripStep", dripStepFn],
      ["Events", eventsFn],
      ["CustomerSync", customerSyncFn],
      ["Signup", signupFn],
      ["SignupBatch", signupBatchFn],
      ["Confirm", confirmFn],
      ["Unsubscribe", unsubscribeFn],
      ["EntitlementWebhook", entitlementFn],
      ["IdentityWebhook", identityFn],
      ["ReengagementSweep", reengagementFn],
      // Present only when the analytics tier is on; filtered below.
      ["AnalyticsTransform", analyticsTransformFn],
      ["AnalyticsSnapshot", analyticsSnapshotFn],
      ["AnalyticsReplay", analyticsReplayFn],
    ].filter((e): e is [string, NodejsFunction] => Boolean(e[1]))) {
      alarm(`${label}ErrorsAlarm`, new Alarm(this, `${label}ErrorsAlarm`, {
        metric: f.metricErrors({ period: Duration.minutes(5) }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription: `addressium: ${label} Lambda errors`,
      }));
      alarm(`${label}ThrottlesAlarm`, new Alarm(this, `${label}ThrottlesAlarm`, {
        metric: f.metricThrottles({ period: Duration.minutes(5) }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription: `addressium: ${label} Lambda throttles`,
      }));
    }
    // DynamoDB pressure — throttles here surface as failed sends and 5xx well
    // before anything else notices.
    alarm("TableThrottleAlarm", new Alarm(this, "TableThrottleAlarm", {
      metric: table.metric("ThrottledRequests", { period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: DynamoDB throttled requests",
    }));
    alarm("TableSystemErrorsAlarm", new Alarm(this, "TableSystemErrorsAlarm", {
      metric: table.metric("SystemErrors", { period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: DynamoDB system errors",
    }));
    // Drip enrollment on the confirm path is best-effort ON PURPOSE: the
    // confirmation is already durable in DynamoDB when it runs, so a Step
    // Functions failure must not turn "you're subscribed" into a 400. The cost of
    // that decision is that the ONLY evidence of a failure is a log line —
    // `console.error` does not increment the Lambda `Errors` metric the
    // ConfirmErrorsAlarm above watches, so an enrollment that silently stopped
    // working looks identical to one that works. Which is #245 exactly: drip mail
    // that nobody sends and nothing notices.
    //
    // So the log line is a metric. It fires on a missing grant, a missing
    // DRIP_STATE_MACHINE_ARN, a throttled StartExecution, and on an enrollment
    // whose previous execution ended in failure — every way this path can be
    // broken by a deploy without failing a request.
    const dripEnrollFailures = new MetricFilter(this, "ConfirmDripEnrollFailureFilter", {
      logGroup: confirmFn.logGroup,
      metricNamespace: `addressium/${props.stage}`,
      metricName: "ConfirmDripEnrollFailures",
      // Matches the literal `confirm: drip enrollment failed` that
      // `enrollConfirmed` logs. Kept in sync by a test on both sides.
      filterPattern: FilterPattern.literal('"confirm: drip enrollment failed"'),
      metricValue: "1",
      defaultValue: 0,
    });
    alarm("ConfirmDripEnrollFailureAlarm", new Alarm(this, "ConfirmDripEnrollFailureAlarm", {
      metric: dripEnrollFailures.metric({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: confirmations are not enrolling into drip sequences (#245)",
    }));
    // A rendering failure is the one event in the SES feed that points at OUR bug
    // rather than a recipient's mailbox: a merge tag that did not resolve, so SES
    // could not build the message at all (#241). It is also campaign-wide by
    // nature — a template broken for one recipient is broken for every one — and
    // the send keeps going regardless, because the handler must not fail a batch
    // over it.
    //
    // So the counter is not enough. `HotCounters.renderingFailures` sits in a
    // per-campaign report an operator opens AFTER the send; this fires while it is
    // still running, which is the only time the information is worth anything.
    /**
     * Per-recipient SES rejections (#293).
     *
     * This alarm exists because the FIX removed the only signal this failure
     * used to have. A permanently-rejected address used to abort the whole
     * slice, which dead-lettered the message — so `SendDlqNotEmptyAlarm` fired.
     * Now the send skips that recipient and carries on, which is right, but it
     * means the DLQ stays empty and a steadily-rotting list would be invisible.
     *
     * The Lambda `Errors` metric cannot cover it either: the invocation
     * succeeds. So the log line is the metric.
     *
     * Threshold is deliberately not zero. Any real list has a few permanently
     * unsendable addresses, and an alarm that fires on every send is one people
     * mute. It fires when rejections are frequent enough to mean list rot or a
     * misclassified account fault.
     */
    const recipientRejects = new MetricFilter(this, "RecipientRejectFilter", {
      logGroup: senderFn.logGroup,
      metricNamespace: `addressium/${props.stage}`,
      metricName: "RecipientRejects",
      // Matches the literal `sendCampaign` logs. Asserted on both sides by a
      // source-text guard — a reworded log line with no filter change would
      // silently stop alarming.
      filterPattern: FilterPattern.literal('"send: recipient rejected"'),
      metricValue: "1",
      defaultValue: 0,
    });
    alarm("RecipientRejectAlarm", new Alarm(this, "RecipientRejectAlarm", {
      metric: recipientRejects.metric({ period: Duration.minutes(15), statistic: "Sum" }),
      threshold: 25,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: SES is refusing many recipients — list rot or a sending-identity fault (#293)",
    }));
    const renderingFailures = new MetricFilter(this, "RenderingFailureFilter", {
      logGroup: eventsFn.logGroup,
      metricNamespace: `addressium/${props.stage}`,
      metricName: "RenderingFailures",
      // Matches the literal the events handler logs. Shared between producer and
      // filter, and asserted on both sides by a source-text guard — a reworded log
      // line with no filter change would silently stop alarming.
      filterPattern: FilterPattern.literal('"events: rendering failure"'),
      metricValue: "1",
      defaultValue: 0,
    });
    alarm("RenderingFailureAlarm", new Alarm(this, "RenderingFailureAlarm", {
      metric: renderingFailures.metric({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: a campaign template is failing to render (#241)",
    }));
    alarm("ApiGatewayServerErrorAlarm", new Alarm(this, "ApiGatewayServerErrorAlarm", {
      metric: api.metricServerError({ period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: API Gateway 5xx server errors",
    }));
    alarm("DripStateMachineFailedAlarm", new Alarm(this, "DripStateMachineFailedAlarm", {
      metric: dripStateMachine.metricFailed({ period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "addressium: Drip state machine execution failed",
    }));
    // Raw message delivery: the queue body is the SES notification itself
    // rather than an SNS envelope wrapping it. `unwrapRecords` peels the
    // envelope defensively anyway, so flipping this cannot silently break
    // resolution — but raw keeps the payload one parse shallower.
    sesEvents.addSubscription(new SqsSubscription(eventsQueue, { rawMessageDelivery: true }));
    eventsFn.addEventSource(
      new SqsEventSource(eventsQueue, {
        batchSize: 10,
        // The handler returns `batchItemFailures`, so a poison event fails on
        // its own instead of taking its nine batch peers down with it (#218,
        // same defect #177 fixed on the send path).
        reportBatchItemFailures: true,
      }),
    );

    // ---- WAF: OPERATOR-SUPPLIED (#225, compendium #30/#31/#66) ----
    //
    // The stack used to create both ACLs. Three problems, all real:
    //
    //  1. A resource carries only ONE WebACL. An operator attaching their own
    //     displaced ours, and the next `cdk deploy` silently put ours back —
    //     their protection disappearing on a routine deploy, with no error.
    //  2. ~$17/month against a ~$4 idle bill: the largest standing cost in a
    //     stack whose whole pitch is that it costs almost nothing at rest.
    //  3. A CLOUDFRONT-scope ACL is only creatable in us-east-1, so any
    //     deployment configured for another region failed at deploy time.
    //
    // We now associate what the operator gives us and emit the ARNs they need
    // to attach one themselves. Alert routing and edge protection are
    // account-wide concerns addressium does not take over.
    const apiStage = api.defaultStage;
    if (props.apiWebAclArn && apiStage) {
      const assoc = new CfnWebACLAssociation(this, "ApiWebAclAssoc", {
        resourceArn: Stack.of(this).formatArn({
          service: "apigateway",
          resource: `/apis/${api.apiId}/stages/${apiStage.stageName}`,
          account: "",
        }),
        webAclArn: props.apiWebAclArn,
      });
      assoc.node.addDependency(apiStage);
    }

    // ---- OpenSearch segmentation mirror (opt-in, §5, #28) ----
    if (enableOpenSearchMirror) {
      const collName = `addressium-${props.stage}`;
      // Where the stream consumer's exhausted batches land (#202). Without it
      // the records were dropped and the mirror diverged with no signal.
      const mirrorDlq = new Queue(this, "MirrorDlq", {
        retentionPeriod: Duration.days(14),
        ...queueEncryption,
      });
      alarm("MirrorDlqNotEmptyAlarm", new Alarm(this, "MirrorDlqNotEmptyAlarm", {
        metric: mirrorDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription: "addressium: OpenSearch mirror is diverging from the table (#202)",
      }));
      // Serverless collection needs an encryption + network policy before it
      // can be created, and a data-access policy for the indexer role.
      const encPolicy = new CfnSecurityPolicy(this, "OsEncPolicy", {
        name: `${collName}-enc`,
        type: "encryption",
        policy: JSON.stringify({
          Rules: [{ ResourceType: "collection", Resource: [`collection/${collName}`] }],
          AWSOwnedKey: true,
        }),
      });
      const netPolicy = new CfnSecurityPolicy(this, "OsNetPolicy", {
        name: `${collName}-net`,
        type: "network",
        policy: JSON.stringify([
          {
            Rules: [
              { ResourceType: "collection", Resource: [`collection/${collName}`] },
              { ResourceType: "dashboard", Resource: [`collection/${collName}`] },
            ],
            // NOT public (#202). `AllowFromPublic: true` put the collection AND
            // its dashboard on the internet, protected only by IAM — a
            // subscriber-attribute mirror reachable from anywhere with a
            // credential. The indexer reaches it over the AWS network as a VPC
            // endpoint principal; an operator who needs dashboard access adds
            // their own source explicitly rather than getting it by default.
            AllowFromPublic: false,
            SourceVPCEs: [],
          },
        ]),
      });
      const collection = new CfnCollection(this, "SegmentCollection", {
        name: collName,
        type: "SEARCH",
        // Standby replicas roughly DOUBLE the OCU floor, and the OCU floor is the
        // largest standing cost in this stack when the mirror is on (#202). Prod
        // keeps them; a scratch environment paying twice for redundancy it does
        // not need is the kind of surprise this project avoids elsewhere.
        standbyReplicas: stage === "prod" ? "ENABLED" : "DISABLED",
      });
      collection.addDependency(encPolicy);
      collection.addDependency(netPolicy);

      const indexerFn = fn("SegmentIndexerFn", svc("services/segment-indexer/src/index.ts"), "handler", {
        OPENSEARCH_ENDPOINT: collection.attrCollectionEndpoint,
      });
      indexerFn.addEventSource(
        new DynamoEventSource(table, {
          startingPosition: StartingPosition.LATEST,
          batchSize: 100,
          retryAttempts: 3,
          // After 3 attempts the records were DROPPED with no destination and no
          // signal, so the OpenSearch mirror diverged from the table silently and
          // stayed diverged — segments quietly resolving against stale data
          // (#202). A DLQ makes the divergence recoverable, and alarmed.
          onFailure: new SqsDestination(mirrorDlq),
          // One poison record used to fail its whole batch of 100 forever. Bisect
          // isolates it so the other 99 land.
          bisectBatchOnError: true,
          reportBatchItemFailures: true,
        }),
      );
      indexerFn.addToRolePolicy(
        new PolicyStatement({ actions: ["aoss:APIAccessAll"], resources: [collection.attrArn] }),
      );
      // Data-access policy: the indexer role may write documents to the index.
      new CfnAccessPolicy(this, "OsDataAccess", {
        name: `${collName}-access`,
        type: "data",
        policy: JSON.stringify([
          {
            Rules: [
              { ResourceType: "index", Resource: [`index/${collName}/*`], Permission: ["aoss:*"] },
              { ResourceType: "collection", Resource: [`collection/${collName}`], Permission: ["aoss:*"] },
            ],
            // The sender READS the mirror (#246); the indexer writes it. Before
            // this the collection had exactly one principal and nothing queried
            // the index it was billing for.
            Principal: [indexerFn.role?.roleArn, senderFn.role?.roleArn],
          },
        ]),
      });
      // The read half (#246). Set only inside this block: the sender selects its
      // engine on the presence of this variable, so it exists if and only if the
      // collection does — the two cannot drift into a sender that believes in an
      // index nobody created.
      senderFn.addEnvironment("OPENSEARCH_ENDPOINT", collection.attrCollectionEndpoint);
      senderFn.addToRolePolicy(
        new PolicyStatement({ actions: ["aoss:APIAccessAll"], resources: [collection.attrArn] }),
      );
      new CfnOutput(this, "SegmentCollectionEndpoint", { value: collection.attrCollectionEndpoint });
    }

    // ---- frontends (static SPAs on S3 + CloudFront, §4.1–4.2) ----
    const prod = stage === "prod";
    // Assign the hoisted bindings the Cognito callback URLs and CORS resolve from.
    //
    // `connect-src` has to name every origin the SPA legitimately talks to (#197):
    // the HTTP API for data, and — for the console — the Cognito Hosted UI, whose
    // /oauth2/token endpoint the PKCE exchange POSTs to directly. `baseUrl()`
    // carries no trailing slash, matching how a browser reports an origin.
    //
    // `api.apiEndpoint` is deliberately NOT used: the API's CORS allowlist
    // already resolves from these distributions, so referencing it here makes
    // the two resources depend on each other and synth fails on the cycle. The
    // wildcard is region-scoped rather than `https:` so exfiltration is at least
    // confined to API Gateway; `apiAppUrl` replaces it with the exact origin.
    const apiOrigin = props.apiAppUrl
      ? stripSlash(props.apiAppUrl)
      : `https://*.execute-api.${this.region}.amazonaws.com`;
    const webAcl = props.cloudfrontWebAclArn ? { webAclId: props.cloudfrontWebAclArn } : {};
    adminSite = new StaticSite(this, "AdminSite", {
      prod,
      ...webAcl,
      connectOrigins: [apiOrigin, adminHostedUi.baseUrl()],
      ...(props.adminCustomDomain
        ? { domainName: props.adminCustomDomain.domainName }
        : {}),
    }); // apps/admin-web
    publicSite = new StaticSite(this, "PublicSite", {
      prod,
      ...webAcl,
      // The subscriber and public sites are unauthenticated — they never touch
      // the admin pool, so the Hosted UI is deliberately not reachable from here.
      connectOrigins: [apiOrigin],
      ...(props.publicCustomDomain
        ? { domainName: props.publicCustomDomain.domainName }
        : {}),
    }); // apps/subscriber-web + public-web

    // ---- outputs ----
    new CfnOutput(this, "AdminPoolId", { value: adminPool.userPoolId });
    new CfnOutput(this, "AdminClientId", { value: adminClient.userPoolClientId });
    new CfnOutput(this, "HttpApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "SendQueueUrl", { value: sendQueue.queueUrl });
    new CfnOutput(this, "SesEventsTopicArn", { value: sesEvents.topicArn });
    // Only exported when addressium created the topic. Echoing back an ARN the
    // operator supplied would imply we own something we do not.
    if (ownedOpsTopic) {
      new CfnOutput(this, "OpsAlertsTopicArn", { value: ownedOpsTopic.topicArn });
    }
    new CfnOutput(this, "SendDlqUrl", { value: sendDlq.queueUrl });
    new CfnOutput(this, "AdminSiteUrl", { value: props.adminCustomDomain?.domainName ?? adminSite.distribution.domainName });
    new CfnOutput(this, "AdminSiteBucket", { value: adminSite.bucket.bucketName });
    new CfnOutput(this, "PublicSiteUrl", { value: props.publicCustomDomain?.domainName ?? publicSite.distribution.domainName });
    new CfnOutput(this, "PublicSiteBucket", { value: publicSite.bucket.bucketName });
    // Cloudflare stays authoritative. These values are exactly the inputs for
    // its DNS UI: add the ACM-provided validation CNAME for each ARN, then CNAME
    // the hostname to the matching CloudFront target. No Route 53 zone access
    // or record mutation is required from Addressium.
    if (adminSite.certificate) {
      new CfnOutput(this, "AdminCertificateArn", { value: adminSite.certificate.certificateArn });
      new CfnOutput(this, "AdminCloudFrontTarget", { value: adminSite.distribution.domainName });
    }
    if (publicSite.certificate) {
      new CfnOutput(this, "PublicCertificateArn", { value: publicSite.certificate.certificateArn });
      new CfnOutput(this, "PublicCloudFrontTarget", { value: publicSite.distribution.domainName });
    }
    new CfnOutput(this, "AuditBucketName", { value: auditBucket.bucketName });

    // ---- operational dashboard (#229, compendium #29) ----
    //
    // Alarms are for the engineer; the console gets a single derived badge. A
    // marketer does not care about Lambda throttles, and an on-call engineer
    // should not have to sign into a marketing console to see them — so these
    // are two surfaces, not one shared screen.
    const dashboard = new Dashboard(this, "OpsDashboard", {
      dashboardName: `addressium-${props.stage}`,
    });
    dashboard.addWidgets(
      new GraphWidget({
        title: "Send pipeline",
        left: [
          sendQueue.metricApproximateNumberOfMessagesVisible(),
          sendQueue.metricApproximateAgeOfOldestMessage(),
        ],
        right: [sendDlq.metricApproximateNumberOfMessagesVisible()],
        width: 12,
      }),
      new GraphWidget({
        title: "Event plane",
        left: [
          eventsQueue.metricApproximateNumberOfMessagesVisible(),
          eventsQueue.metricApproximateAgeOfOldestMessage(),
        ],
        right: [eventsDlq.metricApproximateNumberOfMessagesVisible()],
        width: 12,
      }),
      new GraphWidget({
        title: "Customer-record sync",
        left: [
          customerSyncQueue.metricApproximateNumberOfMessagesVisible(),
          customerSyncQueue.metricApproximateAgeOfOldestMessage(),
        ],
        right: [customerSyncDlq.metricApproximateNumberOfMessagesVisible()],
        width: 12,
      }),
      new GraphWidget({
        title: "Handlers — errors and throttles",
        left: [senderFn.metricErrors(), eventsFn.metricErrors(), adminApiFn.metricErrors()],
        right: [senderFn.metricThrottles(), eventsFn.metricThrottles()],
        width: 12,
      }),
      new GraphWidget({
        title: "DynamoDB",
        left: [table.metricThrottledRequestsForOperations({ operations: [] })],
        right: [table.metricSystemErrorsForOperations({ operations: [] })],
        width: 12,
      }),
      // Alarm state at a glance, so the dashboard answers "is anything wrong"
      // before it answers "what exactly".
      new AlarmStatusWidget({ title: "Alarms", alarms: allAlarms, width: 24 }),
    );
    new CfnOutput(this, "OpsDashboardUrl", {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=addressium-${props.stage}`,
      description: "Operational dashboard (#229)",
    });

    // The ARNs an operator needs to attach their own WebACL (#225, compendium
    // #30/#31). Without these the documented runbook was unfollowable: there
    // was no way to associate an ACL short of hand-deriving ARNs from the
    // console.
    if (apiStage) {
      new CfnOutput(this, "ApiStageArn", {
        value: Stack.of(this).formatArn({
          service: "apigateway",
          resource: `/apis/${api.apiId}/stages/${apiStage.stageName}`,
          account: "",
        }),
        description: "Associate your REGIONAL WebACL with this",
      });
    }
    new CfnOutput(this, "AdminDistributionId", {
      value: adminSite.distribution.distributionId,
      description: "Associate your CLOUDFRONT-scope WebACL with this",
    });
    new CfnOutput(this, "PublicDistributionId", {
      value: publicSite.distribution.distributionId,
      description: "Associate your CLOUDFRONT-scope WebACL with this",
    });

    // ---- reporting read-model (§4.23) ----
    if (enableAnalytics && analyticsStream && analyticsTransformFn && analyticsSnapshotFn) {
      wireAnalytics(this, {
        stage,
        table,
        analyticsBucket,
        analyticsStream,
        transformFn: analyticsTransformFn,
        exportFn: analyticsSnapshotFn,
        eventRetentionDays: analyticsEventRetentionDays,
        alarm,
      });
      new CfnOutput(this, "AnalyticsBucketName", { value: analyticsBucket.bucketName });
      if (analyticsReplayFn) {
        new CfnOutput(this, "AnalyticsReplayFunctionName", {
          value: analyticsReplayFn.functionName,
          description: "Invoke to reprocess records parked under events-errors/ (#186)",
        });
      }
    } else {
      void analyticsBucket;
    }
  }
}
