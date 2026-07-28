/**
 * CDK template assertions (#202).
 *
 * CI ran build + tests and never `cdk synth`, so every infrastructure defect
 * this repo has shipped was synth-visible and invisible to the suite: the audit
 * bucket locked in COMPLIANCE rather than the decided GOVERNANCE (#219), and
 * the SES topic invoking a Lambda directly instead of buffering through SQS
 * (#218). Both are one assertion each.
 *
 * These assert the properties whose loss is unrecoverable or silent — not the
 * shape of the stack, which is expected to change.
 *
 * Bundling is disabled via the `aws:cdk:bundling-stacks: []` context so the
 * template synthesizes without esbuild; asset contents are irrelevant here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ControlPlaneStack } from "../lib/control-plane-stack.js";

function template(props: Record<string, unknown> = {}): Template {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stack = new ControlPlaneStack(app, "test-stack", {
    stage: "dev",
    adminEmails: ["ops@example.com"],
    adminHostedUiDomainPrefix: "addressium-admin",
    env: { account: "111122223333", region: "us-east-1" },
    ...props,
  });
  return Template.fromStack(stack);
}

test("the audit bucket's Object Lock is GOVERNANCE, never COMPLIANCE (#219)", () => {
  // COMPLIANCE cannot be undone by anyone, including AWS, and the bucket is
  // RETAIN — so the mistake would outlive the stack and could never be fixed
  // after the first object was written.
  template().hasResourceProperties("AWS::S3::Bucket", {
    ObjectLockEnabled: true,
    ObjectLockConfiguration: {
      ObjectLockEnabled: "Enabled",
      Rule: { DefaultRetention: Match.objectLike({ Mode: "GOVERNANCE" }) },
    },
  });
});

test("SES events are buffered through SQS, never invoked directly (#218)", () => {
  const t = template();
  // An SNS->Lambda subscription is an async invoke: two retries then the event
  // is discarded. A discarded bounce is an address we keep mailing.
  t.hasResourceProperties("AWS::SNS::Subscription", {
    Protocol: "sqs",
    RawMessageDelivery: true,
  });
  const subs = t.findResources("AWS::SNS::Subscription", { Properties: { Protocol: "lambda" } });
  assert.deepEqual(Object.keys(subs), [], "no SNS topic may invoke a Lambda directly");
});

test("every SQS event source reports partial batch failures", () => {
  const mappings = template().findResources("AWS::Lambda::EventSourceMapping");
  const entries = Object.entries(mappings);
  assert.ok(entries.length >= 2, "send queue + events queue");
  for (const [name, m] of entries) {
    assert.deepEqual(
      (m as { Properties: { FunctionResponseTypes?: string[] } }).Properties.FunctionResponseTypes,
      ["ReportBatchItemFailures"],
      `${name} must fail one poison record without failing its batch peers`,
    );
  }
});

test("every queue has a dead-letter queue", () => {
  const queues = template().findResources("AWS::SQS::Queue");
  const withRedrive = Object.entries(queues).filter(
    ([, q]) => (q as { Properties: Record<string, unknown> }).Properties?.["RedrivePolicy"],
  );
  // Half the queues are the DLQs themselves, which correctly have no redrive.
  assert.equal(
    withRedrive.length * 2,
    Object.keys(queues).length,
    "each working queue needs exactly one DLQ",
  );
});

test("every alarm has an action — an alarm nobody is told about is not monitoring", () => {
  const alarms = template().findResources("AWS::CloudWatch::Alarm");
  assert.ok(Object.keys(alarms).length > 20, "the full alarm set is present");
  for (const [name, a] of Object.entries(alarms)) {
    const actions = (a as { Properties: { AlarmActions?: unknown[] } }).Properties.AlarmActions;
    assert.ok(actions && actions.length > 0, `${name} has no AlarmAction`);
  }
});

test("an operator-supplied ops topic is used, and no topic is created for it (#222)", () => {
  const t = template({ opsAlertTopicArn: "arn:aws:sns:us-east-1:111122223333:my-ops" });
  // Only the SES events topic should remain.
  assert.equal(Object.keys(t.findResources("AWS::SNS::Topic")).length, 1);
  assert.ok(!("OpsAlertsTopicArn" in (t.toJSON().Outputs ?? {})), "we do not export an ARN we do not own");
});

test("opsAlertEmail creates a topic AND subscribes it (#222)", () => {
  const t = template({ opsAlertEmail: "ops@example.com" });
  t.hasResourceProperties("AWS::SNS::Subscription", {
    Protocol: "email",
    Endpoint: "ops@example.com",
  });
});

test("the table is RETAIN with deletion protection and PITR, in every stage (#190)", () => {
  for (const stage of ["dev", "prod"]) {
    const t = template({ stage });
    t.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    });
  }
});

test("log retention is 90 days in prod and 7 otherwise", () => {
  const prod = Object.values(template({ stage: "prod" }).findResources("AWS::Logs::LogGroup"));
  const dev = Object.values(template({ stage: "dev" }).findResources("AWS::Logs::LogGroup"));
  assert.ok(prod.length > 0 && dev.length === prod.length);
  for (const g of prod) {
    assert.equal((g as { Properties: { RetentionInDays: number } }).Properties.RetentionInDays, 90);
  }
  for (const g of dev) {
    assert.equal((g as { Properties: { RetentionInDays: number } }).Properties.RetentionInDays, 7);
  }
});

test("the stack creates NO WebACL of its own (#225)", () => {
  const t = template();
  // A resource carries only one WebACL, so creating our own displaced the
  // operator's — and put ours back on the next deploy, silently.
  assert.deepEqual(Object.keys(t.findResources("AWS::WAFv2::WebACL")), []);
  assert.deepEqual(Object.keys(t.findResources("AWS::WAFv2::WebACLAssociation")), []);
});

test("the ARNs needed to attach your own WebACL are exported (#225)", () => {
  const outs = template().toJSON().Outputs ?? {};
  // Without these the documented runbook is unfollowable.
  assert.ok("ApiStageArn" in outs);
  assert.ok("AdminDistributionId" in outs);
  assert.ok("PublicDistributionId" in outs);
});

test("supplying a WebACL ARN produces an association and still creates no ACL", () => {
  const t = template({ apiWebAclArn: "arn:aws:wafv2:us-east-1:111122223333:regional/webacl/mine/abc" });
  assert.equal(Object.keys(t.findResources("AWS::WAFv2::WebACLAssociation")).length, 1);
  assert.deepEqual(Object.keys(t.findResources("AWS::WAFv2::WebACL")), []);
});

test("the analytics tier is absent unless explicitly enabled", () => {
  const t = template();
  for (const type of [
    "AWS::Kinesis::Stream",
    "AWS::KinesisFirehose::DeliveryStream",
    "AWS::Glue::Database",
    "AWS::Athena::WorkGroup",
    "AWS::OpenSearchServerless::Collection",
  ]) {
    assert.deepEqual(
      Object.keys(t.findResources(type)),
      [],
      `${type} must not exist in a default synth — it is opt-in and carries standing cost`,
    );
  }
});
