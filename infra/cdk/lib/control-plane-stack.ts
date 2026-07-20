/**
 * Shared control-plane stack (docs/ARCHITECTURE.md §3, §9).
 *
 * One per deployment. Declares the resources shared across all organizations:
 * the single DynamoDB table (partitioned by orgId), the admin Cognito pool, the
 * S3 buckets (email archive + analytics lake), the SQS send queue, and the
 * API. Per-org resources are provisioned at runtime (§4.11).
 *
 * This is a scaffold: constructs are declared with TODOs where wiring (Lambda
 * code paths, event sources, IAM) still needs to be filled in. Run
 * `npm install` before `cdk synth`.
 */
import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Mfa, UserPool, UserPoolClient, CfnUserPoolUser } from "aws-cdk-lib/aws-cognito";

export interface ControlPlaneStackProps extends StackProps {
  stage: string;
  /** Seeded at deploy time so someone can sign in without manual pool setup. */
  adminEmails: string[];
  adminHostedUiDomainPrefix: string;
}

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    // Single-table store; every item's PK is prefixed with orgId (§5, §4.11).
    const table = new Table(this, "Table", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: props.stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    // TODO: add GSIs — (listId,status), (subscriberId,lastEngagedAt), email (§5).

    // Immutable generic-email archive that powers the click overlay (§4.8).
    const archiveBucket = new Bucket(this, "ArchiveBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
    });

    // Analytics lake — Firehose delivery target for the event firehose (§7).
    const analyticsBucket = new Bucket(this, "AnalyticsBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // Send fan-out queue consumed by services/sender (§4.4).
    const sendQueue = new Queue(this, "SendQueue", {
      visibilityTimeout: Duration.minutes(5),
    });

    // Staff pool — SEPARATE from the per-org subscriber pools (§4.11, §4.12).
    // Created here (control plane), NOT by hand: this is what makes first login
    // possible. selfSignUp is off — admins are invited, seeded below.
    const adminPool = new UserPool(this, "AdminPool", {
      selfSignUpEnabled: false,
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      signInAliases: { email: true },
      removalPolicy: props.stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Hosted UI domain + client for the admin console (Authorization Code + PKCE).
    adminPool.addDomain("AdminHostedUi", {
      cognitoDomain: { domainPrefix: `${props.adminHostedUiDomainPrefix}-${props.stage}` },
    });
    const adminClient = new UserPoolClient(this, "AdminClient", {
      userPool: adminPool,
      generateSecret: false,
      authFlows: { userSrp: true },
    });

    // Seed the first admin user(s) from config so someone can actually sign in.
    // Cognito emails each a temporary-password invite on create.
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

    // TODO: API Gateway HTTP API + Lambda handlers (services/*), SES config
    // set + SNS/SQS event pipeline, EventBridge Scheduler, Step Functions,
    // Firehose, WAF, CloudFront + S3 for the three frontends.
    void table;
    void archiveBucket;
    void analyticsBucket;
    void sendQueue;

    new CfnOutput(this, "AdminPoolId", { value: adminPool.userPoolId });
    new CfnOutput(this, "AdminClientId", { value: adminClient.userPoolClientId });
  }
}
