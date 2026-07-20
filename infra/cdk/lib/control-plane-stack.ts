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
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Mfa, UserPool, UserPoolClient, CfnUserPoolUser } from "aws-cdk-lib/aws-cognito";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Topic } from "aws-cdk-lib/aws-sns";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";

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
    const table = new Table(this, "Table", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
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
    const sendQueue = new Queue(this, "SendQueue", { visibilityTimeout: Duration.minutes(5) });
    const sesEvents = new Topic(this, "SesEventsTopic");

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

    const apiEntry = svc("services/api/src/index.ts");
    const apiEnv = {
      CONFIRM_SECRET_ARN: confirmSecret.secretArn,
      WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
    };
    const signupFn = fn("SignupFn", apiEntry, "signupHandler", apiEnv);
    const confirmFn = fn("ConfirmFn", apiEntry, "confirmHandler", apiEnv);
    const unsubscribeFn = fn("UnsubscribeFn", apiEntry, "unsubscribeHandler", apiEnv);
    const entitlementFn = fn("EntitlementFn", apiEntry, "entitlementSyncHandler", apiEnv);

    const senderFn = fn("SenderFn", svc("services/sender/src/index.ts"), "handler", {
      // Per-org KMS key + JWKS are resolved from the org record at send time
      // (§4.11); these are deployment defaults / placeholders.
      MAGIC_ISSUER: "https://addressium.example",
      MAGIC_AUDIENCE: "example.com",
      MAGIC_KID: "default",
      MAGIC_KMS_KEY_ID: "TODO-per-org",
    });
    const eventsFn = fn("EventsFn", svc("services/events/src/index.ts"), "handler");

    // ---- permissions ----
    for (const f of [signupFn, confirmFn, unsubscribeFn, entitlementFn, senderFn, eventsFn]) {
      table.grantReadWriteData(f);
    }
    confirmSecret.grantRead(signupFn);
    confirmSecret.grantRead(confirmFn);
    confirmSecret.grantRead(unsubscribeFn);
    webhookSecret.grantRead(entitlementFn);
    archiveBucket.grantReadWrite(senderFn);
    // TODO: grant senderFn kms:Sign on the per-org signing keys (resolved at
    // runtime); grant SES send. Not scoped here since keys are per-org (§4.11).

    // ---- wiring ----
    const api = new HttpApi(this, "HttpApi");
    api.addRoutes({
      path: "/signup",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("SignupInt", signupFn),
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
    api.addRoutes({
      path: "/webhooks/entitlement",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("EntitlementInt", entitlementFn),
    });

    senderFn.addEventSource(new SqsEventSource(sendQueue));
    sesEvents.addSubscription(new LambdaSubscription(eventsFn));

    // ---- outputs ----
    new CfnOutput(this, "AdminPoolId", { value: adminPool.userPoolId });
    new CfnOutput(this, "AdminClientId", { value: adminClient.userPoolClientId });
    new CfnOutput(this, "HttpApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "SendQueueUrl", { value: sendQueue.queueUrl });
    new CfnOutput(this, "SesEventsTopicArn", { value: sesEvents.topicArn });
    void analyticsBucket;
  }
}
