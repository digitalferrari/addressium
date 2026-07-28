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
import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput, Lazy, ArnFormat } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AttributeType, BillingMode, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket, BlockPublicAccess, ObjectLockRetention, StorageClass } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import {
  Mfa,
  UserPool,
  UserPoolClient,
  CfnUserPoolUser,
  StringAttribute,
  OAuthScope,
  ClientAttributes,
  AccountRecovery,
} from "aws-cdk-lib/aws-cognito";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { SqsEventSource, DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { StartingPosition } from "aws-cdk-lib/aws-lambda";
import { CfnCollection, CfnSecurityPolicy, CfnAccessPolicy } from "aws-cdk-lib/aws-opensearchserverless";
import { HttpApi, HttpMethod, CorsHttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription, SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Role, ServicePrincipal, PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
import { CfnScheduleGroup } from "aws-cdk-lib/aws-scheduler";
import {
  Choice,
  Condition,
  DefinitionBody,
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
import { StaticSite } from "./static-site.js";
import { makeCloudFrontWebAcl, makeRegionalWebAcl } from "./waf.js";
import { wireAnalytics } from "./analytics.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const svc = (rel: string) => resolve(REPO_ROOT, rel);

export interface ControlPlaneStackProps extends StackProps {
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
  /**
   * An SNS topic the OPERATOR owns, for infrastructure alarms (#222, compendium
   * #22/#32/#67). When set, no topic is created here and no ARN is exported —
   * alert routing is account-wide plumbing addressium does not take over.
   */
  opsAlertTopicArn?: string;
  /** Create a topic and subscribe this address. Ignored when the ARN is set. */
  opsAlertEmail?: string;
}

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    // ---- data plane ----
    // OpenSearch segmentation mirror is opt-in (standing cost, #28). When on,
    // the table streams changes to the indexer that mirrors to OpenSearch.
    const mirrorCtx = this.node.tryGetContext("enableOpenSearchMirror") as boolean | string | undefined;
    const enableOpenSearchMirror = mirrorCtx === true || mirrorCtx === "true";

    // Reporting read-model (§4.23) is opt-in — when on, the table fans its change
    // stream out to Kinesis for the analytics data lake (separate from the
    // DynamoDB Streams the OpenSearch mirror uses).
    const analyticsCtx = this.node.tryGetContext("enableAnalytics") as boolean | string | undefined;
    const enableAnalytics = analyticsCtx === true || analyticsCtx === "true";
    const analyticsStream = enableAnalytics
      ? new Stream(this, "AnalyticsStream", { streamMode: StreamMode.ON_DEMAND })
      : undefined;

    const table = new Table(this, "Table", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
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
          noncurrentVersionExpiration: Duration.days(30),
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
    });
    // Send pipeline queue with a dead-letter queue (#92): a message that fails
    // to send `maxReceiveCount` times lands in the DLQ instead of being lost, so
    // it can be inspected and replayed. Alarms below page ops when it fills.
    const sendDlq = new Queue(this, "SendDlq", { retentionPeriod: Duration.days(14) });
    const sendQueue = new Queue(this, "SendQueue", {
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: { queue: sendDlq, maxReceiveCount: 5 },
    });
    // Engagement-event buffer (#218, compendium #20/#44). SES → SNS → SQS →
    // Lambda, NOT SNS → Lambda. An SNS→Lambda subscription is an ASYNCHRONOUS
    // invocation: AWS retries twice and then discards the event permanently. A
    // discarded bounce is an address that is never suppressed and keeps being
    // mailed, so the damage compounds silently and is invisible until
    // deliverability is already gone. The queue makes delivery durable and the
    // DLQ makes a failure inspectable and replayable.
    const eventsDlq = new Queue(this, "EventsDlq", { retentionPeriod: Duration.days(14) });
    const eventsQueue = new Queue(this, "EventsQueue", {
      // Comfortably above the handler's own timeout so a slow batch is not
      // redelivered while it is still being processed.
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: { queue: eventsDlq, maxReceiveCount: 5 },
    });
    const sesEvents = new Topic(this, "SesEventsTopic");
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
      : new Topic(this, "OpsAlertsTopic");
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
    const adminOrigin = props.adminAppUrl ? stripSlash(props.adminAppUrl) : siteOrigin(() => adminSite, "AdminSite");
    const publicOrigin = props.publicAppUrl ? stripSlash(props.publicAppUrl) : siteOrigin(() => publicSite, "PublicSite");
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
    });
    adminPool.addDomain("AdminHostedUi", {
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

    // ---- application secrets (passed by ARN; handlers resolve at cold start) ----
    const confirmSecret = new Secret(this, "ConfirmSecret");
    const webhookSecret = new Secret(this, "WebhookSecret");

    // ---- handler functions ----
    const baseEnv = { TABLE_NAME: table.tableName };
    const fn = (id: string, entry: string, handler: string, extraEnv: Record<string, string> = {}) =>
      new NodejsFunction(this, id, {
        entry,
        handler,
        runtime: Runtime.NODEJS_20_X,
        timeout: Duration.seconds(30),
        environment: { ...baseEnv, ...extraEnv },
        bundling: { format: "esm" as never, target: "node20" },
        // Lambda's default log retention is NEVER EXPIRE. With ~40 functions
        // that is unbounded CloudWatch cost forever (#187).
        logGroup: new LogGroup(this, `${id}Logs`, {
          retention: props.stage === "prod" ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });

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

    const apiEntry = svc("services/api/src/index.ts");
    const apiEnv = {
      CONFIRM_SECRET_ARN: confirmSecret.secretArn,
      WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      AUDIT_BUCKET: auditBucket.bucketName, // WORM audit sink (#29)
    };
    const signupFn = fn("SignupFn", apiEntry, "signupHandler", {
      ...apiEnv,
      CONFIRM_URL_BASE:
        (this.node.tryGetContext("confirmUrlBase") as string | undefined) ??
        "https://your-site.example/confirm",
    });
    signupFn.addToRolePolicy(
      sesSendScoped(),
    );
    // /signup now verifies the org's reCAPTCHA secret too (#170).
    signupFn.addToRolePolicy(orgSecretsScoped());
    const signupBatchFn = fn("SignupBatchFn", apiEntry, "signupBatchHandler", {
      ...apiEnv,
      CONFIRM_URL_BASE:
        (this.node.tryGetContext("confirmUrlBase") as string | undefined) ??
        "https://your-site.example/confirm",
    });
    signupBatchFn.addToRolePolicy(
      sesSendScoped(),
    );
    // The embed widget's reCAPTCHA secret is org-configured at runtime (#62).
    signupBatchFn.addToRolePolicy(orgSecretsScoped());
    const confirmFn = fn("ConfirmFn", apiEntry, "confirmHandler", apiEnv);
    // Opt-in post-verify subscriber-account provisioning (#62). Per-org pools are
    // created at runtime, so we can't enumerate ARNs; the handler only calls this
    // when the org explicitly enables createAccountsOnConfirm.
    confirmFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"],
        resources: [
          Stack.of(this).formatArn({ service: "cognito-idp", resource: "userpool", resourceName: "*" }),
        ],
      }),
    );
    // The scoping above still leaves every pool in THIS account in range —
    // including the admin pool. An explicit Deny (which always wins in IAM)
    // closes the actual escalation: a publicly reachable /confirm handler being
    // able to AdminCreateUser its way into the control plane (#167).
    confirmFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ["cognito-idp:*"],
        resources: [adminPool.userPoolArn],
      }),
    );
    const unsubscribeFn = fn("UnsubscribeFn", apiEntry, "unsubscribeHandler", apiEnv);
    const entitlementFn = fn("EntitlementFn", apiEntry, "entitlementSyncHandler", apiEnv);
    const identityFn = fn("IdentityFn", apiEntry, "identitySyncHandler", apiEnv);

    // The sender resolves each org's KMS key + SES config from the org record at
    // send time (§4.11), so no per-org env here.
    // The sender re-enqueues fan-out slices onto the same queue, so it needs the
    // queue URL (services/sender reads SEND_QUEUE_URL at module scope and calls
    // it on the first, unsliced message of every campaign) and send permission.
    const senderFn = fn("SenderFn", svc("services/sender/src/index.ts"), "handler", {
      SEND_QUEUE_URL: sendQueue.queueUrl,
      // RFC 8058 one-click unsubscribe: the header must point at the real route
      // and carry a signed token, so the sender needs both the API base and the
      // confirm secret (#178). Without them it degrades to a mailto header.
      UNSUBSCRIBE_URL_BASE: Lazy.string({ produce: () => `${api.apiEndpoint}/unsubscribe` }),
      CONFIRM_SECRET_ARN: confirmSecret.secretArn,
    });
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
    const eventsFn = fn("EventsFn", svc("services/events/src/index.ts"), "handler");

    // Launch handler for recurring series (EventBridge Scheduler target, §4.16).
    const launchFn = fn("LaunchFn", svc("services/automations/src/index.ts"), "handler", {
      SEND_QUEUE_URL: sendQueue.queueUrl,
    });
    sendQueue.grantSendMessages(launchFn); // each firing enqueues an edition

    // ---- drip automations state machine (§4.6, #23) ----
    // Each step: Wait(waitSeconds) → Task(dripStepHandler) → Choice(done?) loop.
    // The domain owns the per-step choice; the machine just orchestrates.
    const dripStepFn = fn("DripStepFn", svc("services/automations/src/index.ts"), "dripStepHandler", {
      SEND_QUEUE_URL: sendQueue.queueUrl,
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
      }),
      outputPath: "$.Payload",
    });
    const done = new Succeed(this, "DripDone");
    runStep.next(
      new Choice(this, "DripMore")
        .when(Condition.booleanEquals("$.done", true), done)
        .otherwise(waitStep.next(runStep)),
    );
    const dripStateMachine = new StateMachine(this, "DripStateMachine", {
      definitionBody: DefinitionBody.fromChainable(runStep),
      timeout: Duration.days(30),
    });
    table.grantReadWriteData(dripStepFn);
    new CfnOutput(this, "DripStateMachineArn", { value: dripStateMachine.stateMachineArn });

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
    archiveBucket.grantReadWrite(senderFn);
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
    api.addRoutes({
      path: "/unsubscribe",
      methods: [HttpMethod.POST],
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
    const adminApiFn = fn("AdminApiFn", apiEntry, "adminRouter", apiEnv);
    table.grantReadWriteData(adminApiFn);
    const adminApiInt = new HttpLambdaIntegration("AdminApiInt", adminApiFn);
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
    provisioningFn.addToRolePolicy(
      new PolicyStatement({
        // Per-org resources are created at runtime, so their ARNs cannot be
        // enumerated here; these are creation calls, which are inherently
        // account-scoped. The KMS key is tagged app=addressium so downstream
        // grants can scope to it.
        actions: [
          "kms:CreateKey",
          "kms:CreateAlias",
          "kms:TagResource",
          "ses:CreateConfigurationSet",
          "ses:CreateConfigurationSetEventDestination",
          "ses:UpdateConfigurationSetEventDestination",
          "ses:CreateEmailIdentity",
          "ses:GetEmailIdentity",
          "ses:TagResource",
          "cognito-idp:CreateUserPool",
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

    adminRoute("OrgMetaFn", "orgMetaHandler", HttpMethod.GET, "/orgs/{org}");
    adminRoute("SetupStateFn", "setupStateHandler", HttpMethod.GET, "/orgs/{org}/setup");
    adminRoute("ListsGetFn", "listsHandler", HttpMethod.GET, "/orgs/{org}/lists");
    adminRoute("ListsPostFn", "listsHandler", HttpMethod.POST, "/lists");
    adminRoute("ListVisFn", "listVisibilityHandler", HttpMethod.POST, "/lists/visibility");
    adminRoute("CampaignsListFn", "campaignsListHandler", HttpMethod.GET, "/orgs/{org}/campaigns");
    adminRoute("CampaignsGetFn", "campaignsHandler", HttpMethod.GET, "/orgs/{org}/campaigns/{id}");
    adminRoute("CampaignsPostFn", "campaignsHandler", HttpMethod.POST, "/campaigns");
    // Send-schedule lifecycle: list + start/pause/archive (never delete, §4.6).
    adminRoute("SchedulesGetFn", "schedulesListHandler", HttpMethod.GET, "/orgs/{org}/schedules");
    adminRoute("ScheduleLifecycleFn", "scheduleLifecycleHandler", HttpMethod.POST, "/campaigns/lifecycle");
    // Reusable templates (§4.15): list, read one, save.
    adminRoute("TemplatesGetFn", "templatesHandler", HttpMethod.GET, "/orgs/{org}/templates");
    adminRoute("TemplateGetFn", "templatesHandler", HttpMethod.GET, "/orgs/{org}/templates/{id}");
    adminRoute("TemplatesPostFn", "templatesHandler", HttpMethod.POST, "/templates");
    adminRoute("SegmentsGetFn", "segmentsHandler", HttpMethod.GET, "/orgs/{org}/segments");
    adminRoute("SegmentsPostFn", "segmentsHandler", HttpMethod.POST, "/segments");
    // Drip sequences (#104): list + create/edit.
    adminRoute("DripSeqGetFn", "dripSequencesHandler", HttpMethod.GET, "/orgs/{org}/drip-sequences");
    adminRoute("DripSeqPostFn", "dripSequencesHandler", HttpMethod.POST, "/drip-sequences");
    adminRoute("SuppressFn", "subscriberSuppressHandler", HttpMethod.POST, "/subscribers/suppress");
    adminRoute("SubUnsubFn", "subscriberUnsubscribeHandler", HttpMethod.POST, "/subscribers/unsubscribe");
    // Operator-side subscriber management (#102): list/search, suppression list,
    // and lift-suppression.
    adminRoute("SubscribersListFn", "subscribersListHandler", HttpMethod.GET, "/orgs/{org}/subscribers");
    adminRoute("SuppressionsListFn", "suppressionsListHandler", HttpMethod.GET, "/orgs/{org}/suppressions");
    adminRoute("UnsuppressFn", "subscriberUnsuppressHandler", HttpMethod.POST, "/subscribers/unsuppress");
    // Subscriber migration (#100) + GDPR/CCPA data-subject requests (#101).
    adminRoute("ImportFn", "importHandler", HttpMethod.POST, "/orgs/{org}/import");
    adminRoute("PrivacyFn", "privacyHandler", HttpMethod.POST, "/privacy");
    adminRoute("BrandingPostFn", "brandingHandler", HttpMethod.POST, "/orgs/branding");
    // Deliverability thresholds — these drive the auto-halt (#217).
    adminRoute("AlertConfigGetFn", "alertConfigHandler", HttpMethod.GET, "/orgs/{org}/alerts");
    adminRoute("AlertConfigPostFn", "alertConfigHandler", HttpMethod.POST, "/orgs/alerts");
    adminRoute("PresentationFn", "listPresentationHandler", HttpMethod.POST, "/lists/presentation");
    // AI config writes the API key to Secrets Manager (create/put).
    const aiConfigFn = adminRoute("AiConfigFn", "aiConfigHandler", HttpMethod.POST, "/orgs/ai-config");
    aiConfigFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"],
        resources: ["*"],
      }),
    );

    // Public (no auth): branding + list view the subscriber site reads.
    const publicBrandingFn = fn("PublicBrandingFn", apiEntry, "brandingHandler", apiEnv);
    table.grantReadData(publicBrandingFn);
    api.addRoutes({
      path: "/orgs/{org}/branding",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("PublicBrandingInt", publicBrandingFn),
    });
    const publicListFn = fn("PublicListFn", apiEntry, "publicListHandler", apiEnv);
    table.grantReadData(publicListFn);
    api.addRoutes({
      path: "/orgs/{org}/lists/{list}/public",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("PublicListInt", publicListFn),
    });

    // ---- reporting (report, usage, AI analysis) — §4.8, #13/#26/#32 ----
    const reportingEntry = svc("services/reporting/src/index.ts");
    const reportFn = fn("ReportFn", reportingEntry, "handler", apiEnv);
    table.grantReadData(reportFn);
    api.addRoutes({
      path: "/orgs/{org}/campaigns/{campaign}/report",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("ReportInt", reportFn),
      authorizer: adminAuth,
    });
    // Usage & cost (§11) — surfaced on the admin Usage screen.
    const usageFn = fn("UsageFn", reportingEntry, "usageHandler", apiEnv);
    table.grantReadData(usageFn);
    const usageInt = new HttpLambdaIntegration("UsageInt", usageFn);
    api.addRoutes({ path: "/orgs/{org}/usage", methods: [HttpMethod.GET], integration: usageInt, authorizer: adminAuth });
    api.addRoutes({ path: "/orgs/{org}/usage/{period}", methods: [HttpMethod.GET], integration: usageInt, authorizer: adminAuth });

    const analyzeFn = fn("AnalyzeFn", reportingEntry, "analyzeHandler", apiEnv);
    table.grantReadData(analyzeFn);
    analyzeFn.addToRolePolicy(orgSecretsScoped());
    api.addRoutes({
      path: "/reports/analyze",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("AnalyzeInt", analyzeFn),
      authorizer: adminAuth,
    });

    // reportBatchItemFailures is required for the handler's `batchItemFailures`
    // return value to mean anything. Without it one throw failed the WHOLE batch
    // and redelivered the other 9 messages — re-sending already-delivered mail,
    // up to maxReceiveCount times (#177). maxConcurrency bounds the aggregate
    // SES rate: the TokenBucket is per-invocation, so N concurrent senders
    // otherwise multiply the configured rate by N (#176).
    senderFn.addEventSource(
      new SqsEventSource(sendQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        maxConcurrency: 5,
      }),
    );

    // ---- infra alarms (#92) — page ops on a stuck/failing send pipeline ----
    const alarmAction = new SnsAction(opsAlerts);
    const alarm = (id: string, a: Alarm) => {
      a.addAlarmAction(alarmAction);
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
    // Lambda errors + throttles across the critical send path AND the public
    // surface. Previously only the three send-path functions were alarmed, so a
    // failing signup, confirm, unsubscribe, webhook, or SES-event handler was
    // completely silent — including bounce/complaint processing (#187).
    for (const [label, f] of [
      ["Sender", senderFn],
      ["Launch", launchFn],
      ["DripStep", dripStepFn],
      ["Events", eventsFn],
      ["Signup", signupFn],
      ["SignupBatch", signupBatchFn],
      ["Confirm", confirmFn],
      ["Unsubscribe", unsubscribeFn],
      ["EntitlementWebhook", entitlementFn],
      ["IdentityWebhook", identityFn],
    ] as const) {
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

    // ---- WAF (managed rule sets + per-IP rate limit + signup CAPTCHA, §5, #20) ----
    // REGIONAL ACL on the HTTP API stage; CLOUDFRONT ACL on the SPA distributions.
    const apiWebAcl = makeRegionalWebAcl(this, "ApiWebAcl");
    const stage = api.defaultStage;
    if (stage) {
      const assoc = new CfnWebACLAssociation(this, "ApiWebAclAssoc", {
        resourceArn: Stack.of(this).formatArn({
          service: "apigateway",
          resource: `/apis/${api.apiId}/stages/${stage.stageName}`,
          account: "",
        }),
        webAclArn: apiWebAcl.attrArn,
      });
      assoc.node.addDependency(stage);
    }
    const cfWebAcl = makeCloudFrontWebAcl(this, "CfWebAcl");

    // ---- OpenSearch segmentation mirror (opt-in, §5, #28) ----
    if (enableOpenSearchMirror) {
      const collName = `addressium-${props.stage}`;
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
            AllowFromPublic: true,
          },
        ]),
      });
      const collection = new CfnCollection(this, "SegmentCollection", {
        name: collName,
        type: "SEARCH",
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
            Principal: [indexerFn.role?.roleArn],
          },
        ]),
      });
      new CfnOutput(this, "SegmentCollectionEndpoint", { value: collection.attrCollectionEndpoint });
    }

    // ---- frontends (static SPAs on S3 + CloudFront, §4.1–4.2) ----
    const prod = props.stage === "prod";
    // Assign the hoisted bindings the Cognito callback URLs and CORS resolve from.
    adminSite = new StaticSite(this, "AdminSite", { prod, webAclId: cfWebAcl.attrArn }); // apps/admin-web
    publicSite = new StaticSite(this, "PublicSite", { prod, webAclId: cfWebAcl.attrArn }); // apps/subscriber-web + public-web

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
    new CfnOutput(this, "AdminSiteUrl", { value: adminSite.distribution.domainName });
    new CfnOutput(this, "AdminSiteBucket", { value: adminSite.bucket.bucketName });
    new CfnOutput(this, "PublicSiteUrl", { value: publicSite.distribution.domainName });
    new CfnOutput(this, "PublicSiteBucket", { value: publicSite.bucket.bucketName });
    new CfnOutput(this, "AuditBucketName", { value: auditBucket.bucketName });

    // ---- reporting read-model (§4.23) ----
    if (enableAnalytics && analyticsStream) {
      const transformFn = fn("AnalyticsExportFn", svc("services/analytics-export/src/index.ts"), "handler");
      const snapshotFn = fn("AnalyticsSnapshotFn", svc("services/analytics-export/src/index.ts"), "exportHandler", {
        TABLE_ARN: table.tableArn,
        ANALYTICS_BUCKET: analyticsBucket.bucketName,
      });
      wireAnalytics(this, {
        stage: props.stage,
        table,
        analyticsBucket,
        analyticsStream,
        transformFn,
        exportFn: snapshotFn,
      });
      new CfnOutput(this, "AnalyticsBucketName", { value: analyticsBucket.bucketName });
    } else {
      void analyticsBucket;
    }
  }
}
