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
import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AttributeType, BillingMode, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket, BlockPublicAccess, ObjectLockRetention } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Mfa, UserPool, UserPoolClient, CfnUserPoolUser } from "aws-cdk-lib/aws-cognito";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { SqsEventSource, DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { StartingPosition } from "aws-cdk-lib/aws-lambda";
import { CfnCollection, CfnSecurityPolicy, CfnAccessPolicy } from "aws-cdk-lib/aws-opensearchserverless";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { Topic } from "aws-cdk-lib/aws-sns";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Role, ServicePrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
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
      removalPolicy: props.stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
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
    });
    // Audit log backed by S3 Object Lock (WORM) — history can't be rewritten
    // even by an admin (§4.19, docs/SECURITY.md §4.3, #29). COMPLIANCE mode +
    // a default retention makes every written object immutable for the window.
    const auditRetentionYears = Number(
      (this.node.tryGetContext("auditRetentionYears") as string | undefined) ?? 7,
    );
    const auditBucket = new Bucket(this, "AuditBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: ObjectLockRetention.compliance(
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
    const sesEvents = new Topic(this, "SesEventsTopic");
    // Ops alerts topic (#92): infra-level CloudWatch alarms (DLQ depth, queue
    // age, Lambda errors/throttles) publish here. Subscribe your ops channel;
    // this is the same escalation path as the domain-layer deliverability alerts.
    const opsAlerts = new Topic(this, "OpsAlertsTopic");

    // ---- admin pool (control plane, seeded so first login works — §9.1) ----
    const adminPool = new UserPool(this, "AdminPool", {
      selfSignUpEnabled: false,
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      signInAliases: { email: true },
      removalPolicy: props.stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    adminPool.addDomain("AdminHostedUi", {
      cognitoDomain: { domainPrefix: `${props.adminHostedUiDomainPrefix}-${props.stage}` },
    });
    const adminClient = new UserPoolClient(this, "AdminClient", {
      userPool: adminPool,
      generateSecret: false,
      authFlows: { userSrp: true },
    });
    props.adminEmails.forEach((email, i) => {
      new CfnUserPoolUser(this, `AdminSeed${i}`, {
        userPoolId: adminPool.userPoolId,
        username: email,
        desiredDeliveryMediums: ["EMAIL"],
        userAttributes: [
          { name: "email", value: email },
          { name: "email_verified", value: "true" },
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
      });

    // ses:SendEmail scoped to *this account's* SES identities + configuration
    // sets (#93). Per-org identities/config-sets are created by provisioning at
    // runtime so their exact ARNs can't be enumerated here, but restricting to
    // this account/region's `identity/*` and `configuration-set/*` is a real
    // tightening from `resources: ["*"]` (blocks sending as any other account's
    // verified identity). A fresh statement per caller keeps roles independent.
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
    signupBatchFn.addToRolePolicy(
      new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: ["*"] }),
    );
    const confirmFn = fn("ConfirmFn", apiEntry, "confirmHandler", apiEnv);
    // Opt-in post-verify subscriber-account provisioning (#62). Per-org pools are
    // created at runtime, so we can't enumerate ARNs; the handler only calls this
    // when the org explicitly enables createAccountsOnConfirm.
    confirmFn.addToRolePolicy(
      new PolicyStatement({ actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"], resources: ["*"] }),
    );
    const unsubscribeFn = fn("UnsubscribeFn", apiEntry, "unsubscribeHandler", apiEnv);
    const entitlementFn = fn("EntitlementFn", apiEntry, "entitlementSyncHandler", apiEnv);
    const identityFn = fn("IdentityFn", apiEntry, "identitySyncHandler", apiEnv);

    // The sender resolves each org's KMS key + SES config from the org record at
    // send time (§4.11), so no per-org env here.
    const senderFn = fn("SenderFn", svc("services/sender/src/index.ts"), "handler");
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
    const eventsFn = fn("EventsFn", svc("services/events/src/index.ts"), "handler");

    // Launch handler for recurring series (EventBridge Scheduler target, §4.16).
    const launchFn = fn("LaunchFn", svc("services/automations/src/index.ts"), "handler", {
      SEND_QUEUE_URL: sendQueue.queueUrl,
    });

    // ---- drip automations state machine (§4.6, #23) ----
    // Each step: Wait(waitSeconds) → Task(dripStepHandler) → Choice(done?) loop.
    // The domain owns the per-step choice; the machine just orchestrates.
    const dripStepFn = fn("DripStepFn", svc("services/automations/src/index.ts"), "dripStepHandler", {
      SEND_QUEUE_URL: sendQueue.queueUrl,
    });
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
    webhookSecret.grantRead(entitlementFn);
    webhookSecret.grantRead(identityFn);
    archiveBucket.grantReadWrite(senderFn);
    // kms:Sign is scoped by the addressium key-tag condition and ses:SendEmail to
    // this account's SES identities/config-sets (#93). Per-org signing keys are
    // created by provisioning at runtime and tagged app=addressium, so the tag
    // condition covers them without enumerating ARNs here (§4.11).

    // ---- wiring ----
    const api = new HttpApi(this, "HttpApi");
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
    const adminRoute = (id: string, handler: string, method: HttpMethod, path: string, env = apiEnv) => {
      const f = fn(id, apiEntry, handler, env);
      table.grantReadWriteData(f);
      api.addRoutes({
        path,
        methods: [method],
        integration: new HttpLambdaIntegration(`${id}Int`, f),
        authorizer: adminAuth,
      });
      return f;
    };
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
    analyzeFn.addToRolePolicy(
      new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: ["*"] }),
    );
    api.addRoutes({
      path: "/reports/analyze",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("AnalyzeInt", analyzeFn),
      authorizer: adminAuth,
    });

    senderFn.addEventSource(new SqsEventSource(sendQueue));

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
    // Lambda errors + throttles across the critical send path.
    for (const [label, f] of [["Sender", senderFn], ["Launch", launchFn], ["DripStep", dripStepFn]] as const) {
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
    sesEvents.addSubscription(new LambdaSubscription(eventsFn));

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
    const adminSite = new StaticSite(this, "AdminSite", { prod, webAclId: cfWebAcl.attrArn }); // apps/admin-web
    const publicSite = new StaticSite(this, "PublicSite", { prod, webAclId: cfWebAcl.attrArn }); // apps/subscriber-web + public-web

    // ---- outputs ----
    new CfnOutput(this, "AdminPoolId", { value: adminPool.userPoolId });
    new CfnOutput(this, "AdminClientId", { value: adminClient.userPoolClientId });
    new CfnOutput(this, "HttpApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "SendQueueUrl", { value: sendQueue.queueUrl });
    new CfnOutput(this, "SesEventsTopicArn", { value: sesEvents.topicArn });
    new CfnOutput(this, "OpsAlertsTopicArn", { value: opsAlerts.topicArn });
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
