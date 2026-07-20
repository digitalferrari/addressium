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
import { Stack, type StackProps, RemovalPolicy, Duration } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { UserPool } from "aws-cdk-lib/aws-cognito";

export interface ControlPlaneStackProps extends StackProps {
  stage: string;
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
    const adminPool = new UserPool(this, "AdminPool", {
      selfSignUpEnabled: false,
      mfa: undefined, // TODO: require TOTP MFA
    });

    // TODO: API Gateway HTTP API + Lambda handlers (services/*), SES config
    // set + SNS/SQS event pipeline, EventBridge Scheduler, Step Functions,
    // Firehose, WAF, CloudFront + S3 for the three frontends.
    void table;
    void archiveBucket;
    void analyticsBucket;
    void sendQueue;
    void adminPool;
  }
}
