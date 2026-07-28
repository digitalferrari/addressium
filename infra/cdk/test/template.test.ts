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

/**
 * `props` become stack props; `context` becomes app context, which is where the
 * deploy-time knobs live (`cdk deploy -c auditRetentionYears=…`).
 */
function template(
  props: Record<string, unknown> = {},
  context: Record<string, unknown> = {},
): Template {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [], ...context } });
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

test("an operational dashboard exists, with its URL exported (#229)", () => {
  const t = template();
  assert.equal(Object.keys(t.findResources("AWS::CloudWatch::Dashboard")).length, 1);
  assert.ok("OpsDashboardUrl" in (t.toJSON().Outputs ?? {}));
});

test("the analytics tier is absent unless explicitly enabled", () => {
  const t = template();
  // The table must carry no stream either — a stream is billable and is the
  // thing the OpenSearch mirror hangs off, so leaving one on would mean "off by
  // default" was true of the visible resources and false of the cost.
  const tables = Object.values(t.findResources("AWS::DynamoDB::Table"));
  for (const table of tables) {
    assert.equal(
      (table.Properties as { StreamSpecification?: unknown }).StreamSpecification,
      undefined,
      "a default synth must leave the table streamless",
    );
  }
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

test("the export bucket expires its objects and is not versioned (#224)", () => {
  // An export object is an org's entire subscriber base in one file, and the
  // presigned URL handed out for it cannot be revoked — so the object's own
  // lifetime is the backstop. A version would be a second full copy of that PII
  // that plain expiry would not reach.
  const buckets = Object.values(template().findResources("AWS::S3::Bucket"));
  const exportBuckets = buckets.filter((b) =>
    (b.Properties?.LifecycleConfiguration?.Rules ?? []).some(
      (r: { Id?: string }) => r.Id === "expire-exports",
    ),
  );
  assert.equal(exportBuckets.length, 1, "exactly one export bucket");
  const props = exportBuckets[0]!.Properties as Record<string, unknown>;
  const rule = (props.LifecycleConfiguration as { Rules: Record<string, unknown>[] }).Rules.find(
    (r) => r.Id === "expire-exports",
  )!;

  assert.equal(rule.Status, "Enabled");
  assert.equal((rule.ExpirationInDays as number) <= 7, true, "exports must not linger");
  assert.ok(rule.AbortIncompleteMultipartUpload, "an interrupted export must not bill forever");
  assert.equal(props.VersioningConfiguration, undefined, "a version is a second copy of the PII");
  assert.deepEqual(props.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
});

test("the audit bucket archives cheaply but stays readable (#191)", () => {
  // Seven years of audit objects is real standing cost, but the console reads
  // this bucket directly now. A Deep Archive object cannot be fetched without a
  // restore that takes hours, so the viewer would fail outright on anything
  // older than the transition — the log would be retained and unreadable, which
  // is the worst of both.
  const audit = Object.values(template().findResources("AWS::S3::Bucket")).find(
    (b) => b.Properties?.ObjectLockEnabled === true,
  );
  assert.ok(audit, "the WORM audit bucket exists");
  const rules =
    (audit.Properties as { LifecycleConfiguration?: { Rules: Record<string, unknown>[] } })
      .LifecycleConfiguration?.Rules ?? [];
  const transitions = rules.flatMap((r) => (r.Transitions ?? []) as { StorageClass: string }[]);
  assert.ok(transitions.length > 0, "audit objects must not sit in STANDARD for seven years");
  for (const t of transitions) {
    assert.notEqual(t.StorageClass, "DEEP_ARCHIVE", "a restore-required class breaks the viewer");
    assert.notEqual(t.StorageClass, "GLACIER", "likewise — GLACIER Flexible needs a restore");
  }
});

/** Statements attached to the role of the function whose logical id starts with `prefix`. */
function policyFor(t: ReturnType<typeof template>, prefix: string): Record<string, unknown>[] {
  const fns = t.findResources("AWS::Lambda::Function");
  const logicalId = Object.keys(fns).find((k) => k.startsWith(prefix));
  assert.ok(logicalId, `no function named ${prefix}*`);
  const roleRef = (fns[logicalId]!.Properties as { Role: { "Fn::GetAtt": string[] } }).Role[
    "Fn::GetAtt"
  ][0];

  const out: Record<string, unknown>[] = [];
  for (const p of Object.values(t.findResources("AWS::IAM::Policy"))) {
    const roles = (p.Properties as { Roles?: { Ref: string }[] }).Roles ?? [];
    if (!roles.some((r) => r.Ref === roleRef)) continue;
    out.push(
      ...(((p.Properties as { PolicyDocument: { Statement: Record<string, unknown>[] } })
        .PolicyDocument.Statement) ?? []),
    );
  }
  return out;
}

const actionsOf = (s: Record<string, unknown>): string[] =>
  Array.isArray(s.Action) ? (s.Action as string[]) : s.Action ? [s.Action as string] : [];

test("the /confirm handler cannot reach Cognito at all (#23)", () => {
  // It is the most exposed route in the product: unauthenticated, linked from
  // every confirmation email, the first thing an attacker probes. It used to
  // hold AdminCreateUser on every pool in the account, so a compromise there
  // reached the operator's user directory. It now holds lambda:InvokeFunction
  // on one function and nothing else.
  const t = template();
  const statements = policyFor(t, "ConfirmFn");
  const cognito = statements
    .filter((s) => s.Effect !== "Deny")
    .flatMap(actionsOf)
    .filter((a) => a.startsWith("cognito-idp:"));
  assert.deepEqual(cognito, [], `/confirm still holds ${cognito.join(", ")}`);

  const invokes = statements.flatMap(actionsOf).filter((a) => a.startsWith("lambda:Invoke"));
  assert.ok(invokes.length > 0, "it must still be able to ASK for provisioning");
});

test("the provisioner holds the Cognito grant, and is denied the admin pool (#23, #167)", () => {
  const statements = policyFor(template(), "SubscriberAccountFn");
  const allowed = statements
    .filter((s) => s.Effect !== "Deny")
    .flatMap(actionsOf)
    .filter((a) => a.startsWith("cognito-idp:"));
  assert.ok(allowed.includes("cognito-idp:AdminCreateUser"));
  assert.ok(allowed.includes("cognito-idp:AdminSetUserPassword"));
  // Never a wildcard action: this role may create and read a subscriber, not
  // reconfigure a pool.
  assert.ok(!allowed.includes("cognito-idp:*"), "the ALLOW must stay enumerated");

  // The explicit Deny is what closes the escalation the wildcard resource leaves
  // open — provisioning a "subscriber" into the control plane's own directory.
  const denies = statements.filter((s) => s.Effect === "Deny").flatMap(actionsOf);
  assert.ok(denies.includes("cognito-idp:*"), "no Deny on the admin pool");
});

test("naming the linked pools in context replaces the account-wide wildcard (#23)", () => {
  // Subscriber pools belong to the operator and are linked at runtime, so their
  // ARNs cannot be enumerated at synth. Naming them is what turns "every pool in
  // the account" into the two that are actually linked.
  const t = template({}, { subscriberPoolIds: ["us-east-1_aaa", "us-east-1_bbb"] });
  const resources = policyFor(t, "SubscriberAccountFn")
    .filter((s) => s.Effect !== "Deny")
    .filter((s) => actionsOf(s).some((a) => a.startsWith("cognito-idp:")))
    .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]));

  const rendered = JSON.stringify(resources);
  assert.match(rendered, /us-east-1_aaa/);
  assert.match(rendered, /us-east-1_bbb/);
  assert.doesNotMatch(rendered, /userpool\/\*/, "the wildcard must be gone once pools are named");
});

test("no role can write a secret, and no AI route exists (#227)", () => {
  // The AI advisory layer was cut from the compendium at r2 and deleted. Its
  // API-key upsert was the ONLY thing in the product that wrote a secret, so
  // the grant went with it. This asserts the absence rather than trusting it:
  // reintroducing a write here would also reintroduce reach over this stack's
  // own confirmation-token and webhook signing secrets, and rotating those
  // silently invalidates every outstanding opt-in link and inbound webhook.
  const t = template();
  for (const policy of Object.values(t.findResources("AWS::IAM::Policy"))) {
    const doc = (policy.Properties as { PolicyDocument: { Statement: Record<string, unknown>[] } })
      .PolicyDocument;
    for (const st of doc.Statement ?? []) {
      if (st.Effect === "Deny") continue;
      // Enumerated, not "anything that isn't a read": CDK's grantRead bundles
      // DescribeSecret and GetSecretValue, both harmless, and an inverted filter
      // would fail on those while missing an action nobody thought to exclude.
      const WRITES = [
        "secretsmanager:CreateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:RestoreSecret",
        "secretsmanager:TagResource",
        "secretsmanager:*",
      ];
      const writes = actionsOf(st).filter((a) => WRITES.includes(a));
      assert.deepEqual(writes, [], `a role may write secrets: ${writes.join(", ")}`);
    }
  }

  // And neither route survives, in CDK or in the router.
  const routes = JSON.stringify(t.findResources("AWS::ApiGatewayV2::Route"));
  assert.doesNotMatch(routes, /ai-config/);
  assert.doesNotMatch(routes, /reports\/analyze/);
});

test("...and the flags actually turn it on (#228)", () => {
  // The other half of "opt-in", and the half that decides whether this tier is a
  // feature or dead code. If the flag did nothing, "off by default" would be
  // trivially true and the whole tier would be unreachable — which is exactly
  // the reading that made deleting it look reasonable.
  const t = template({}, { enableAnalytics: true });
  assert.ok(
    Object.keys(t.findResources("AWS::KinesisFirehose::DeliveryStream")).length > 0,
    "enableAnalytics must produce the delivery stream",
  );
  assert.ok(Object.keys(t.findResources("AWS::Glue::Database")).length > 0);
  assert.ok(Object.keys(t.findResources("AWS::Athena::WorkGroup")).length > 0);
});

test("the send queue caps sender concurrency, and the sender divides by it (#176)", () => {
  // The TokenBucket is per-INVOCATION. SQS→Lambda scales the sender out, so N
  // concurrent invocations each pacing to the full account rate produce N × the
  // quota — SES throttles mid-loop, the claim is already burned, and those
  // recipients are silently lost. Both halves must be present: the cap, and the
  // sender knowing what the cap is so it can divide.
  const t = template();
  const mappings = Object.values(t.findResources("AWS::Lambda::EventSourceMapping"));
  const capped = mappings.filter(
    (m) => (m.Properties as { ScalingConfig?: { MaximumConcurrency?: number } }).ScalingConfig
      ?.MaximumConcurrency !== undefined,
  );
  assert.ok(capped.length > 0, "the send queue's event source must cap concurrency");

  const fns = t.findResources("AWS::Lambda::Function");
  const sender = Object.entries(fns).find(([k]) => k.startsWith("SenderFn"));
  assert.ok(sender, "SenderFn exists");
  const env = (sender[1].Properties as { Environment?: { Variables?: Record<string, string> } })
    .Environment?.Variables ?? {};
  assert.ok(env.SENDER_MAX_CONCURRENCY, "the sender must know the cap to divide by it");
  assert.ok(env.SES_MAX_SEND_RATE, "and the account rate it is dividing");

  // The two must agree — a cap of 5 with the sender told 10 is worse than
  // neither, because it looks configured.
  const cap = (capped[0]!.Properties as { ScalingConfig: { MaximumConcurrency: number } })
    .ScalingConfig.MaximumConcurrency;
  assert.equal(Number(env.SENDER_MAX_CONCURRENCY), cap, "cap and divisor must be one value");
});

test("public endpoints reserve concurrency so a big send cannot starve them (#176)", () => {
  // /unsubscribe above all: "we could not process your unsubscribe because we
  // were busy sending you email" is a compliance failure, not a slow page.
  const fns = template().findResources("AWS::Lambda::Function");
  const reserved = (prefix: string): number | undefined => {
    const hit = Object.entries(fns).find(([k]) => k.startsWith(prefix));
    assert.ok(hit, `${prefix} exists`);
    return (hit[1].Properties as { ReservedConcurrentExecutions?: number })
      .ReservedConcurrentExecutions;
  };
  for (const p of ["UnsubscribeFn", "ConfirmFn", "SignupFn", "PublicDirectoryFn"]) {
    assert.ok((reserved(p) ?? 0) > 0, `${p} has no reserved concurrency`);
  }
  assert.ok(
    (reserved("UnsubscribeFn") ?? 0) >= (reserved("SignupFn") ?? 0),
    "unsubscribe is the one that must never be starved",
  );
});

test("the drip handler is told the SES rate so it can pace itself (#176)", () => {
  // dripStepHandler passed NO throttle at all, so a large cohort ran flat out
  // against the same account quota a campaign was using.
  const fns = template().findResources("AWS::Lambda::Function");
  const drip = Object.entries(fns).find(([k]) => k.startsWith("DripStepFn"));
  assert.ok(drip, "DripStepFn exists");
  const env = (drip[1].Properties as { Environment?: { Variables?: Record<string, string> } })
    .Environment?.Variables ?? {};
  assert.ok(env.SES_MAX_SEND_RATE, "the drip path must know the rate it is dividing");
});
