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
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ControlPlaneStack, STAGES, parseStage } from "../lib/control-plane-stack.js";
import { HTML_BODY_ROUTES, makeCloudFrontWebAcl, makeRegionalWebAcl } from "../lib/waf.js";
import { entitiesExportPrefix } from "@addressium/domain";

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
  //
  // ONE deliberate exception since #234: the ConfirmSecret rotation function.
  // It is allowed to write because it APPENDS a key to the keyring rather than
  // replacing one — it structurally cannot cause the harm this test guards
  // against, and its `testSecret` step refuses to promote a version that stops
  // verifying the outgoing key's tokens. Every other policy still gets zero.
  const t = template();
  for (const [id, policy] of Object.entries(t.findResources("AWS::IAM::Policy"))) {
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
      if (id.startsWith("ConfirmSecretRotationFn")) {
        // Scoped to ConfirmSecret alone. The rotation function must not be able
        // to touch WebhookSecret, whose rotation has none of these protections.
        const resources = flatten(st.Resource);
        assert.ok(!resources.includes("WebhookSecret"), "rotation reaches the webhook secret");
        continue;
      }
      assert.deepEqual(writes, [], `${id} may write secrets: ${writes.join(", ")}`);
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

test("the drip machine waits before step 0, retries, and outlives 30 days (#201)", () => {
  const machines = Object.values(template().findResources("AWS::StepFunctions::StateMachine"));
  const drip = machines.find((m) =>
    JSON.stringify((m.Properties as { DefinitionString?: unknown }).DefinitionString ?? "").includes("DripRunStep"),
  );
  assert.ok(drip, "the drip state machine exists");
  const props = drip.Properties as { DefinitionString: unknown };
  const def = JSON.parse(
    // CDK renders the definition as an Fn::Join of literals and refs; the
    // literals carry everything asserted here.
    (((props.DefinitionString as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"]?.[1] ?? [])
      .filter((p): p is string => typeof p === "string")
      .join("") || String(props.DefinitionString)
    ).replace(/"Resource":"[^"]*$/, '"Resource":"x"}}}'),
  ) as { StartAt: string; TimeoutSeconds?: number; States: Record<string, Record<string, unknown>> };

  // Starting at the step fired step 0 immediately, so "three days after signup"
  // arrived at signup.
  assert.equal(def.StartAt, "DripWait", "the machine must wait before the first step");

  // 30 days truncated any sequence longer than a month, mid-flight.
  assert.ok((def.TimeoutSeconds ?? 0) > 30 * 24 * 60 * 60, "a drip can run for months");

  const step = def.States.DripRunStep!;
  assert.ok(Array.isArray(step.Retry) && step.Retry.length > 0, "a transient blip must not end the sequence");
  assert.ok(Array.isArray(step.Catch) && step.Catch.length > 0, "a permanent failure must be visible");
});

/**
 * Flatten a CloudFormation string value to something assertable.
 *
 * The CSP contains the Hosted-UI origin and `AWS::Region`, so CDK renders it as
 * an `Fn::Join` of literals and refs. Asserting on the raw object would silently
 * pass whatever it was handed — `String({})` is `"[object Object]"`, which
 * contains none of the directives and matches none of the negative patterns.
 */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (value && typeof value === "object") {
    const join = (value as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"];
    if (join) return join[1].map(flatten).join(join[0]);
    // A Ref/GetAtt: keep the logical id so an origin can still be identified.
    return Object.values(value as Record<string, unknown>).map(flatten).join("");
  }
  return "";
}

/** The CSP each site's response-headers policy sets, keyed by construct id. */
function cspBySite(t: Template): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, p] of Object.entries(t.findResources("AWS::CloudFront::ResponseHeadersPolicy"))) {
    const cfg = (p.Properties as { ResponseHeadersPolicyConfig: Record<string, unknown> })
      .ResponseHeadersPolicyConfig;
    const items =
      ((cfg.CustomHeadersConfig as { Items?: { Header: string; Value: unknown }[] } | undefined)
        ?.Items ?? []);
    const csp = items.find((h) => h.Header.toLowerCase() === "content-security-policy");
    if (csp) out[id] = flatten(csp.Value);
  }
  return out;
}

test("both SPA distributions ship CSP and HSTS (#197)", () => {
  // The console renders operator-authored HTML in a GrapesJS editor and in a
  // preview iframe. With no CSP, any XSS there reads sessionStorage and walks
  // off with the id token — a full operator session for its whole lifetime,
  // with no refresh flow to revoke and no server-side session to end.
  const t = template();
  const policies = Object.entries(t.findResources("AWS::CloudFront::ResponseHeadersPolicy"));
  assert.equal(policies.length, 2, "one policy per distribution (admin + public)");

  for (const [id, p] of policies) {
    const sec = (p.Properties as { ResponseHeadersPolicyConfig: Record<string, any> })
      .ResponseHeadersPolicyConfig.SecurityHeadersConfig;
    assert.ok(
      (sec?.StrictTransportSecurity?.AccessControlMaxAgeSec ?? 0) >= 31_536_000,
      `${id}: HSTS must be at least a year`,
    );
    assert.equal(sec?.ContentTypeOptions?.Override, true, `${id}: no MIME sniffing`);
    assert.equal(sec?.FrameOptions?.FrameOption, "DENY", `${id}: not framable`);
  }

  const csps = cspBySite(t);
  assert.equal(Object.keys(csps).length, 2, "both policies set a CSP header");
  for (const [id, csp] of Object.entries(csps)) {
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ]) {
      assert.ok(csp.includes(directive), `${id}: missing ${directive} — got ${csp}`);
    }
    // `script-src` must never be loosened: 'unsafe-inline' or 'unsafe-eval'
    // there gives back exactly the execution the policy exists to deny.
    const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";
    assert.doesNotMatch(scriptSrc, /unsafe-(inline|eval)/, `${id}: script-src was loosened`);

    // `connect-src` must stay an allowlist. A bare `*` or `https:` lets injected
    // code post the token to its own collector, which is the whole point of the
    // header. A host-scoped wildcard is the documented fallback (see
    // `apiAppUrl`), so only the open forms are rejected.
    const connectSrc = /connect-src ([^;]*)/.exec(csp)?.[1] ?? "";
    assert.ok(connectSrc, `${id}: connect-src is set`);
    for (const open of ["*", "https:", "http:", "data:"]) {
      assert.ok(!connectSrc.split(/\s+/).includes(open), `${id}: connect-src allows ${open}`);
    }
  }

  // A policy attached to nothing sets no headers at all.
  for (const [id, d] of Object.entries(t.findResources("AWS::CloudFront::Distribution"))) {
    const cfg = (d.Properties as { DistributionConfig: Record<string, any> }).DistributionConfig;
    assert.ok(
      cfg.DefaultCacheBehavior?.ResponseHeadersPolicyId,
      `${id}: the default behaviour must reference the policy`,
    );
  }
});

test("the admin CSP reaches the Hosted UI; the public one does not (#197)", () => {
  // The PKCE exchange POSTs straight to Cognito's /oauth2/token, so the console
  // needs that origin. The subscriber and public sites never authenticate an
  // operator, and an unnecessary connect-src entry is an exfiltration path that
  // costs nothing to close.
  const csps = cspBySite(template());
  const admin = Object.entries(csps).find(([id]) => id.startsWith("AdminSite"))?.[1];
  const pub = Object.entries(csps).find(([id]) => id.startsWith("PublicSite"))?.[1];
  assert.ok(admin && pub, "both sites have a CSP");
  assert.match(admin, /auth\..*amazoncognito\.com/, "the console can reach the Hosted UI");
  assert.doesNotMatch(pub, /amazoncognito/, "the public site cannot");
  // Both talk to the API.
  assert.match(admin, /execute-api/);
  assert.match(pub, /execute-api/);
});

test("apiAppUrl pins connect-src to one exact origin (#197)", () => {
  // The default is region-scoped rather than api-scoped, because naming the API
  // from a distribution closes a dependency cycle with the API's CORS allowlist.
  // An operator who has an endpoint or a custom domain can close that gap.
  const csps = cspBySite(template({ apiAppUrl: "https://api.example.com/" }));
  for (const [id, csp] of Object.entries(csps)) {
    const connectSrc = /connect-src ([^;]*)/.exec(csp)?.[1] ?? "";
    // Trailing slash stripped: a browser reports an origin without one, so
    // "https://api.example.com/" would never match the request it is guarding.
    assert.ok(connectSrc.split(/\s+/).includes("https://api.example.com"), `${id}: ${connectSrc}`);
    assert.ok(!connectSrc.includes("execute-api"), `${id}: the wildcard must be replaced`);
  }
});

test("the analytics lake has a bounded retention window, not 'forever' (#164)", () => {
  // The fact tier carries `subscriber_id`, which is pseudonymous personal data,
  // and an S3 object cannot be edited per subject — so a GDPR erasure rests on
  // two things: the tombstone every query anti-joins against, and this rule
  // eventually removing the rows outright. "Retained indefinitely" is not a
  // retention policy anyone can defend to a regulator.
  const buckets = Object.values(template({}, { enableAnalytics: "true" }).findResources("AWS::S3::Bucket"));
  const rulesOf = (b: Record<string, any>) =>
    (b.Properties?.LifecycleConfiguration?.Rules ?? []) as Record<string, any>[];
  const analytics = buckets.find((b) =>
    rulesOf(b as Record<string, any>).some((r) => r.Prefix === "events/"),
  );
  assert.ok(analytics, "the analytics bucket exists when the tier is enabled");

  const events = rulesOf(analytics as Record<string, any>).find((r) => r.Prefix === "events/")!;
  assert.ok(events.ExpirationInDays > 0, "the fact tier must expire");
  // Every prefix that can hold subject data is bounded, not just the fact tier:
  // the nightly full-table export lands RAW subscriber items under entities/.
  for (const prefix of ["entities/", "athena-results/", "events-errors/"]) {
    const r: Record<string, any> | undefined = rulesOf(analytics as Record<string, any>).find(
      (x) => x.Prefix === prefix,
    );
    assert.ok((r?.ExpirationInDays ?? 0) > 0, `${prefix} must expire`);
  }
});

test("the erasure report's retention window is the one the bucket enforces (#164)", () => {
  // The number an operator is TOLD and the number that actually expires the rows
  // come from the same context value. If they drift, the erasure report is a
  // claim nobody can check.
  const t = template({}, { enableAnalytics: "true", analyticsEventRetentionDays: "45" });
  const bucket = Object.values(t.findResources("AWS::S3::Bucket")).find((b) =>
    ((b.Properties as Record<string, any>)?.LifecycleConfiguration?.Rules ?? []).some(
      (r: Record<string, unknown>) => r.Prefix === "events/",
    ),
  )!;
  const rule = ((bucket.Properties as Record<string, any>).LifecycleConfiguration.Rules as Record<string, any>[])
    .find((r) => r.Prefix === "events/")!;
  assert.equal(rule.ExpirationInDays, 45);

  // …and the API is told the same number, so its report matches.
  const fns = t.findResources("AWS::Lambda::Function");
  const admin = Object.entries(fns).find(([k]) => k.startsWith("AdminApiFn"))!;
  const env = (admin[1].Properties as { Environment?: { Variables?: Record<string, string> } })
    .Environment?.Variables ?? {};
  assert.equal(env.ANALYTICS_EVENT_RETENTION_DAYS, "45");
  assert.equal(env.ANALYTICS_ENABLED, "true");
});

test("an invalid stage fails at synth (#190)", () => {
  // Every data-protection decision keys off this string. `"production"` and
  // `"Prod"` both compared unequal to `"prod"`, so a config typo produced a
  // stack holding production data while configured as a scratch environment.
  for (const bad of ["production", "Prod", "PROD", "prod ", "test", ""]) {
    assert.throws(
      () => template({ stage: bad }),
      /invalid stage/,
      `accepted ${JSON.stringify(bad)}`,
    );
  }
  // …and the valid set still synthesizes.
  for (const ok of ["dev", "staging", "prod"]) {
    assert.doesNotThrow(() => template({ stage: ok }), ok);
  }
});

test("parseStage names the valid values in its error (#190)", () => {
  // The operator is editing a JSON file they never compile, so the message is
  // the entire interface. "invalid stage" alone sends them to the source.
  assert.throws(() => parseStage("production"), (e: Error) => {
    assert.match(e.message, /dev, staging, prod/);
    assert.match(e.message, /"production"/);
    return true;
  });
  assert.deepEqual([...STAGES], ["dev", "staging", "prod"]);
});

test("a prod stack refuses cdk destroy; a dev stack does not (#190)", () => {
  // The removal policies already RETAIN the data, but a destroyed stack still
  // tears down the API, the queues and the schedules — an outage, and not
  // something anyone should reach by running the wrong command in the wrong
  // terminal.
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const base = {
    adminEmails: ["ops@example.com"],
    adminHostedUiDomainPrefix: "addressium-admin",
    env: { account: "111122223333", region: "us-east-1" },
  };
  assert.equal(
    new ControlPlaneStack(app, "prod-stack", { ...base, stage: "prod" }).terminationProtection,
    true,
  );
  assert.equal(
    new ControlPlaneStack(app, "dev-stack", { ...base, stage: "dev" }).terminationProtection,
    false,
  );
});

test("both secrets are RETAIN, in every stage (#190)", () => {
  // `ConfirmSecret` signs every outstanding double-opt-in and one-click
  // unsubscribe token. Losing it does not just break new links — it invalidates
  // every link already sitting in someone's inbox, including the unsubscribe
  // link the law requires to work.
  for (const stage of ["dev", "staging", "prod"]) {
    const secrets = template({ stage }).findResources("AWS::SecretsManager::Secret");
    assert.equal(Object.keys(secrets).length, 2, `${stage}: confirm + webhook`);
    for (const [id, sec] of Object.entries(secrets)) {
      assert.equal(
        (sec as { DeletionPolicy?: string }).DeletionPolicy,
        "Retain",
        `${stage}/${id} would be deleted with the stack`,
      );
    }
  }
});

test("prod gets a backup plan whose vault outlives the stack (#190)", () => {
  // PITR is NOT a backup: a 35-day continuous window that lives inside the table
  // and dies with it. A backup has to be a different resource with a different
  // lifecycle.
  const t = template({ stage: "prod" });
  const vaults = t.findResources("AWS::Backup::BackupVault");
  assert.equal(Object.keys(vaults).length, 1);
  assert.equal(
    (Object.values(vaults)[0] as { DeletionPolicy?: string }).DeletionPolicy,
    "Retain",
    "a vault destroyed with the stack is a backup that vanishes when it is needed",
  );

  const plans = Object.values(t.findResources("AWS::Backup::BackupPlan"));
  assert.equal(plans.length, 1);
  const rules = (plans[0]!.Properties as { BackupPlan: { BackupPlanRule: Record<string, any>[] } })
    .BackupPlan.BackupPlanRule;
  // Daily covering the PITR window, plus a monthly for "we noticed in March that
  // something broke in January".
  assert.deepEqual(
    rules.map((r) => r.RuleName).sort(),
    ["daily-35d", "monthly-1y"],
  );
  assert.equal(rules.find((r) => r.RuleName === "daily-35d")?.Lifecycle?.DeleteAfterDays, 35);
  assert.equal(rules.find((r) => r.RuleName === "monthly-1y")?.Lifecycle?.DeleteAfterDays, 365);
  assert.equal(Object.keys(t.findResources("AWS::Backup::BackupSelection")).length, 1);
});

test("a non-prod stage does not silently start billing for backups (#190)", () => {
  // Off by default outside prod — a standing cost proportional to table size is
  // exactly the kind of surprise this project avoids elsewhere. Both directions
  // are overridable.
  assert.deepEqual(Object.keys(template({ stage: "dev" }).findResources("AWS::Backup::BackupVault")), []);
  assert.equal(
    Object.keys(
      template({ stage: "dev" }, { enableBackup: "true" }).findResources("AWS::Backup::BackupVault"),
    ).length,
    1,
  );
  assert.deepEqual(
    Object.keys(
      template({ stage: "prod" }, { enableBackup: "false" }).findResources("AWS::Backup::BackupVault"),
    ),
    [],
  );
});

test("both analytics Lambdas are alarmed like every other handler (#186)", () => {
  // They were built at the very bottom of the stack, after the alarm loop AND
  // after the dashboard — so neither had an error or throttle alarm. A transform
  // failing on every record diverted the whole fact tier to `events-errors/`
  // with nobody paged.
  const t = template({}, { enableAnalytics: "true" });
  const alarms = t.findResources("AWS::CloudWatch::Alarm");
  for (const label of ["AnalyticsTransform", "AnalyticsSnapshot", "AnalyticsReplay"]) {
    for (const kind of ["Errors", "Throttles"]) {
      const id = Object.keys(alarms).find((k) => k.startsWith(`${label}${kind}Alarm`));
      assert.ok(id, `${label} has no ${kind} alarm`);
      const actions = (alarms[id!]!.Properties as { AlarmActions?: unknown[] }).AlarmActions;
      assert.ok(actions?.length, `${label}${kind} alarms nobody`);
    }
  }
});

test("the pipeline itself is watched, not just its Lambdas (#186)", () => {
  // The scenario: 100% of records fail, everything diverts to `events-errors/`,
  // and Athena keeps answering from older partitions — just progressively
  // emptier. Freshness catches "delivery stopped" whatever the cause; the
  // processing-failure count catches records being parked.
  const t = template({}, { enableAnalytics: "true" });
  const alarms = t.findResources("AWS::CloudWatch::Alarm");
  const byMetric = (name: string) =>
    Object.values(alarms).find((a) => (a.Properties as { MetricName?: string }).MetricName === name);

  const freshness = byMetric("DeliveryToS3.DataFreshness");
  assert.ok(freshness, "nothing watches whether the fact tier is reaching S3");
  assert.equal((freshness!.Properties as { Namespace: string }).Namespace, "AWS/Firehose");
  assert.ok((freshness!.Properties as { AlarmActions?: unknown[] }).AlarmActions?.length);

  const failures = byMetric("ExecuteProcessingFailure.Records");
  assert.ok(failures, "nothing watches records landing in events-errors/");
  // Threshold 0: any record parked is a record missing from every report until
  // someone replays it.
  assert.equal((failures!.Properties as { Threshold: number }).Threshold, 0);
});

test("the Firehose stream logs to CloudWatch (#186)", () => {
  // It had no logging configuration at all, so a delivery or transformation
  // failure produced no signal anywhere — the diversion to `events-errors/` was
  // the only evidence, and nothing watched that either.
  const t = template({}, { enableAnalytics: "true" });
  const streams = Object.values(t.findResources("AWS::KinesisFirehose::DeliveryStream"));
  assert.equal(streams.length, 1);
  const cfg = (streams[0]!.Properties as { ExtendedS3DestinationConfiguration: Record<string, any> })
    .ExtendedS3DestinationConfiguration;
  assert.equal(cfg.CloudWatchLoggingOptions?.Enabled, true);
  assert.ok(cfg.CloudWatchLoggingOptions?.LogGroupName);
  assert.ok(cfg.CloudWatchLoggingOptions?.LogStreamName);
});

test("a replay function exists and can write the lake (#186)", () => {
  // Records parked under `events-errors/` were unreachable: nothing reprocessed
  // the prefix, so the diversion was permanent.
  const t = template({}, { enableAnalytics: "true" });
  const fns = t.findResources("AWS::Lambda::Function");
  const replay = Object.keys(fns).find((k) => k.startsWith("AnalyticsReplayFn"));
  assert.ok(replay, "no replay function");
  assert.ok("AnalyticsReplayFunctionName" in (t.toJSON().Outputs ?? {}), "and no way to find it");

  // It must be able to READ the error prefix and WRITE the events prefix —
  // read-only would make it a diagnostic rather than a recovery.
  const policies = Object.values(t.findResources("AWS::IAM::Policy"));
  const grants = policies.flatMap((p) =>
    ((p.Properties as { PolicyDocument: { Statement: Record<string, any>[] } }).PolicyDocument.Statement ?? [])
      .flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action])),
  );
  assert.ok(grants.includes("s3:PutObject"), "replay cannot write recovered rows");
  assert.ok(grants.includes("s3:DeleteObject*") || grants.includes("s3:DeleteObject"),
    "replay cannot clear the source, so a second run would duplicate rows");
});

test("none of the analytics wiring exists when the tier is off (#186)", () => {
  // The alarms and the replay function are opt-in with the tier they watch —
  // otherwise a default deploy pays for alarms on a pipeline it does not have.
  const t = template();
  assert.deepEqual(Object.keys(t.findResources("AWS::KinesisFirehose::DeliveryStream")), []);
  const alarms = Object.keys(t.findResources("AWS::CloudWatch::Alarm"));
  assert.ok(!alarms.some((a) => a.startsWith("Analytics")), `stray analytics alarms: ${alarms}`);
  const fns = Object.keys(t.findResources("AWS::Lambda::Function"));
  assert.ok(!fns.some((f) => f.startsWith("AnalyticsReplayFn")));
});

// ---- the reference WebACLs (#188) ----
//
// Nothing in the stack builds these — addressium creates no WebACL (#225), the
// operator supplies one. They are tested anyway BECAUSE of that: this file is
// what an operator copies, so a defect here ships to every install by hand
// instead of by deploy, which is worse rather than better.

function referenceAcls() {
  const app = new App();
  const stack = new Stack(app, "waf-stack", { env: { account: "111122223333", region: "us-east-1" } });
  makeRegionalWebAcl(stack, "ApiAcl");
  makeCloudFrontWebAcl(stack, "SiteAcl");
  return Template.fromStack(stack);
}

const aclRules = (t: Template, scope: "REGIONAL" | "CLOUDFRONT") => {
  const acl = Object.values(t.findResources("AWS::WAFv2::WebACL")).find(
    (a) => (a.Properties as { Scope: string }).Scope === scope,
  )!;
  return (acl.Properties as { Rules: Record<string, any>[] }).Rules;
};

test("the managed rules that break template saving are COUNT, not BLOCK (#188)", () => {
  // `SizeRestrictions_BODY` blocks bodies over 8KB and `CrossSiteScripting_BODY`
  // blocks bodies containing markup — which is exactly what an email template
  // IS. Attached with no exclusions, they break `POST /campaigns` and
  // `POST /templates`: the two requests the console cannot work without.
  const common = aclRules(referenceAcls(), "REGIONAL").find(
    (r) => r.Name === "AWSManagedRulesCommonRuleSet",
  )!;
  const overrides = common.Statement.ManagedRuleGroupStatement.RuleActionOverrides ?? [];
  const byName = Object.fromEntries(overrides.map((o: Record<string, any>) => [o.Name, o.ActionToUse]));
  assert.ok(byName["SizeRestrictions_BODY"]?.Count, "SizeRestrictions_BODY still blocks");
  assert.ok(byName["CrossSiteScripting_BODY"]?.Count, "CrossSiteScripting_BODY still blocks");
  // COUNT rather than removed, so the rules keep emitting metrics and an
  // operator can tune from evidence instead of guesswork.
  assert.equal(common.OverrideAction?.None !== undefined, true);
});

test("body-size protection is restored everywhere it does not break things (#188)", () => {
  // Counting `SizeRestrictions_BODY` turns it off for EVERY route, including the
  // unauthenticated ones where a multi-megabyte body is pure denial-of-wallet.
  const rules = aclRules(referenceAcls(), "REGIONAL");
  const oversize = rules.find((r) => r.Name === "OversizeBodyOutsideHtmlRoutes");
  assert.ok(oversize, "no replacement body-size rule — the hole is API-wide");
  assert.ok(oversize.Action?.Block);
  // It must run BEFORE the managed sets, so a large body is rejected without
  // being handed to them.
  const common = rules.find((r) => r.Name === "AWSManagedRulesCommonRuleSet")!;
  assert.ok(oversize.Priority < common.Priority);

  // …and it must exempt exactly the routes that carry email HTML.
  const exempted = JSON.stringify(oversize.Statement);
  for (const route of HTML_BODY_ROUTES) {
    assert.ok(exempted.includes(route), `${route} would still be blocked`);
  }
});

test("/signup/batch is not CAPTCHA-challenged (#188)", () => {
  // It is called by the subscriber site's "all newsletters" page, not typed by a
  // person. A CAPTCHA challenge to a non-browser client is a broken endpoint.
  const captcha = aclRules(referenceAcls(), "REGIONAL").find((r) => r.Name === "SignupCaptcha")!;
  const match = captcha.Statement.AndStatement.Statements.find(
    (s: Record<string, any>) => s.ByteMatchStatement?.FieldToMatch?.UriPath,
  );
  assert.equal(
    match.ByteMatchStatement.PositionalConstraint,
    "EXACTLY",
    "STARTS_WITH also catches /signup/batch",
  );
  assert.equal(match.ByteMatchStatement.SearchString, "/signup");
});

test("path matches survive encoded-path evasion (#188)", () => {
  // With only LOWERCASE, `/%73ignup` never matched and neither did
  // `/foo/../signup`. A CAPTCHA any scripted client steps around by
  // percent-encoding one character is decoration.
  for (const rule of aclRules(referenceAcls(), "REGIONAL")) {
    for (const m of JSON.stringify(rule).matchAll(/"UriPath":\{\}[^}]*\}[^}]*?"TextTransformations":(\[[^\]]*\])/g)) {
      const types = (JSON.parse(m[1]!) as { Type: string }[]).map((t) => t.Type);
      assert.ok(types.includes("URL_DECODE"), `${rule.Name}: missing URL_DECODE`);
      assert.ok(types.includes("NORMALIZE_PATH"), `${rule.Name}: missing NORMALIZE_PATH`);
    }
  }
});

test("signup carries its own, much tighter rate limit (#188)", () => {
  // The global 2000-per-5-minutes rule permits 2000 signups per IP per 5
  // minutes, which is a brake on a different and much larger problem. Signup is
  // the route that costs money when abused.
  const rules = aclRules(referenceAcls(), "REGIONAL");
  const signup = rules.find((r) => r.Name === "SignupRateLimitPerIp");
  assert.ok(signup, "signup shares the blunt global ceiling");
  const global = rules.find((r) => r.Name === "RateLimitPerIp")!;
  assert.ok(
    signup.Statement.RateBasedStatement.Limit < global.Statement.RateBasedStatement.Limit,
    "the scoped limit must actually be tighter",
  );
  // Scoped to the signup paths — including /signup/batch, which needs a rate
  // limit even though it must not be CAPTCHA'd.
  assert.ok(signup.Statement.RateBasedStatement.ScopeDownStatement);
});

test("both ACLs log, with credentials redacted (#188)", () => {
  // No logging meant no abuse forensics and no evidence to tune a rule from — a
  // WAF that blocks template saving with no log is indistinguishable from a
  // broken deploy.
  const t = referenceAcls();
  const configs = Object.values(t.findResources("AWS::WAFv2::LoggingConfiguration"));
  assert.equal(configs.length, 2, "one per ACL");
  for (const c of configs) {
    const props = c.Properties as Record<string, any>;
    assert.ok(props.LogDestinationConfigs?.length);
    // A WAF log is a request log; one containing bearer tokens is a credential
    // store.
    assert.ok(
      JSON.stringify(props.RedactedFields ?? []).toLowerCase().includes("authorization"),
      "authorization header is not redacted",
    );
  }
  // WAF rejects any destination whose name does not start with `aws-waf-logs-`.
  for (const g of Object.values(t.findResources("AWS::Logs::LogGroup"))) {
    assert.match((g.Properties as { LogGroupName: string }).LogGroupName, /^aws-waf-logs-/);
  }
});

test("the CloudFront ACL keeps the managed rules intact (#188)", () => {
  // These distributions serve static built assets and take no request bodies, so
  // there is nothing legitimate for the body rules to break. The exception
  // belongs only where the application actually posts markup.
  const common = aclRules(referenceAcls(), "CLOUDFRONT").find(
    (r) => r.Name === "AWSManagedRulesCommonRuleSet",
  )!;
  assert.equal(
    common.Statement.ManagedRuleGroupStatement.RuleActionOverrides,
    undefined,
    "the SPA ACL should not inherit the API's exceptions",
  );
});

test("the stack still creates no WebACL of its own (#225 holds)", () => {
  // The reference above is exported for an operator to use in THEIR app. If it
  // ever gets wired into this stack it would displace whatever they associated,
  // and the next deploy would put ours back silently.
  assert.deepEqual(Object.keys(template().findResources("AWS::WAFv2::WebACL")), []);
});

test("the re-engagement sweep finally has an invoker (#233)", () => {
  // It existed, was exported, and NO CDK construct referenced it — the whole
  // sunset automation was domain logic with no caller, and its 21 unit tests
  // passed throughout because they exercise the domain function directly.
  const t = template();
  const fns = t.findResources("AWS::Lambda::Function");
  const sweep = Object.keys(fns).find((k) => k.startsWith("ReengagementSweepFn"));
  assert.ok(sweep, "no sweep function");

  const rules = Object.values(t.findResources("AWS::Events::Rule"));
  const weekly = rules.find((r) =>
    String((r.Properties as { ScheduleExpression?: string }).ScheduleExpression ?? "").includes("MON"),
  );
  assert.ok(weekly, "nothing fires the sweep");
  // Weekly, not daily: step spacing is measured in days and the default policy
  // waits 180 for coldness, so a daily pass does nothing 6 days in 7 while
  // paying for a full org scan each time.
  assert.match(
    (weekly!.Properties as { ScheduleExpression: string }).ScheduleExpression,
    /cron\(0 4 \? \* MON \*\)/,
  );
  assert.ok(
    (weekly!.Properties as { Targets?: unknown[] }).Targets?.length,
    "a rule with no target fires into nothing",
  );

  // And it is alarmed like every other handler — a silent sweep that
  // unsubscribes people is the worst kind to leave unwatched.
  const alarms = Object.keys(t.findResources("AWS::CloudWatch::Alarm"));
  assert.ok(alarms.some((a) => a.startsWith("ReengagementSweepErrorsAlarm")));
});

test("the sweep gets a long timeout, because it walks a whole org (#233)", () => {
  // It checkpoints and resumes, so a timeout costs one page rather than the
  // pass — but the default 30s would mean resuming constantly.
  const fns = template().findResources("AWS::Lambda::Function");
  const sweep = Object.entries(fns).find(([k]) => k.startsWith("ReengagementSweepFn"))!;
  const timeout = (sweep[1].Properties as { Timeout?: number }).Timeout ?? 0;
  assert.ok(timeout >= 300, `sweep timeout is ${timeout}s`);
});

// ---- encryption, reliability and governance (#202) ----

test("the data plane uses a customer-managed key, not the AWS-owned one (#202)", () => {
  // The default gives no CloudTrail record of key usage, no rotation control and
  // no crypto-shredding — all three of which an auditor expects on a
  // multi-tenant PII store.
  const t = template();
  const keys = Object.values(t.findResources("AWS::KMS::Key"));
  assert.ok(keys.length >= 1, "no CMK");
  const key = keys[0]!;
  assert.equal((key.Properties as { EnableKeyRotation?: boolean }).EnableKeyRotation, true);
  // A deleted key makes every ciphertext permanently unreadable — including the
  // backups, which are encrypted with it. That is total loss no restore survives.
  assert.equal((key as { DeletionPolicy?: string }).DeletionPolicy, "Retain");

  t.hasResourceProperties("AWS::DynamoDB::Table", {
    SSESpecification: Match.objectLike({ SSEEnabled: true }),
  });
});

test("SNS topics are encrypted at rest (#202)", () => {
  // SNS is NOT encrypted by default, unlike S3/DynamoDB/Kinesis, and the SES
  // events topic carries bounce and complaint notifications containing
  // subscriber email addresses. The synthesized topic had no Properties at all.
  const topics = Object.entries(template({ opsAlertEmail: "ops@example.com" })
    .findResources("AWS::SNS::Topic"));
  assert.ok(topics.length >= 2);
  for (const [id, topic] of topics) {
    assert.ok(
      (topic.Properties as { KmsMasterKeyId?: unknown })?.KmsMasterKeyId,
      `${id} is unencrypted`,
    );
  }
});

test("queue encryption is DECLARED, not merely inherited (#202)", () => {
  // SQS does encrypt by default, but the template said nothing — and an auditor
  // reads the template, not the service documentation.
  for (const [id, q] of Object.entries(template().findResources("AWS::SQS::Queue"))) {
    const p = q.Properties as { SqsManagedSseEnabled?: boolean; KmsMasterKeyId?: unknown };
    assert.ok(p.SqsManagedSseEnabled === true || p.KmsMasterKeyId, `${id} declares no encryption`);
  }
});

test("the send archive cannot be deleted by the sender (#202)", () => {
  // `grantReadWrite` includes `s3:DeleteObject*`, and that wildcard matches
  // `DeleteObjectVersion` — so versioning did NOT protect the evidentiary
  // archive from a compromised or buggy sender, which is the one thing
  // versioning was there to do.
  const t = template();
  const archive = Object.entries(t.findResources("AWS::S3::Bucket")).find(([id]) =>
    id.startsWith("ArchiveBucket"),
  )!;
  const arnRef = archive[0];

  for (const policy of Object.values(t.findResources("AWS::IAM::Policy"))) {
    const doc = (policy.Properties as { PolicyDocument: { Statement: Record<string, any>[] } })
      .PolicyDocument;
    for (const st of doc.Statement ?? []) {
      const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
      if (!actions.some((a: string) => typeof a === "string" && a.startsWith("s3:DeleteObject"))) continue;
      // A delete grant exists somewhere — it must not reach the archive bucket.
      assert.ok(
        !JSON.stringify(st.Resource ?? "").includes(arnRef),
        `a policy grants ${actions.join(",")} on the send archive`,
      );
    }
  }
});

test("a WAF-blocked request is not answered 200 OK (#202)", () => {
  // Mapping 403 → 200 meant the block still happened but scanners, uptime
  // monitors and WAF metric consumers all saw success — an edge control that
  // works and reports that it does not.
  for (const [id, d] of Object.entries(template().findResources("AWS::CloudFront::Distribution"))) {
    const responses =
      ((d.Properties as { DistributionConfig: Record<string, any> }).DistributionConfig
        .CustomErrorResponses ?? []) as Record<string, number>[];
    assert.ok(
      !responses.some((r) => r.ErrorCode === 403),
      `${id} still rewrites 403 to a success page`,
    );
    // 404 → index.html stays: that is SPA routing, and S3 now returns 404 for a
    // missing key because the distribution can list the bucket.
    assert.ok(responses.some((r) => r.ErrorCode === 404 && r.ResponseCode === 200));
  }
});

test("the OpenSearch mirror is not on the public internet (#202)", () => {
  // `AllowFromPublic: true` put the collection AND its dashboard on the
  // internet, protected only by IAM — a mirror of every subscriber attribute
  // reachable from anywhere with a credential.
  const t = template({}, { enableOpenSearchMirror: "true" });
  const net = Object.values(t.findResources("AWS::OpenSearchServerless::SecurityPolicy")).find((p) =>
    (p.Properties as { Type: string }).Type === "network",
  )!;
  const policy = JSON.parse((net.Properties as { Policy: string }).Policy) as Record<string, any>[];
  for (const rule of policy) {
    assert.equal(rule.AllowFromPublic, false, "the mirror is publicly reachable");
  }
});

test("standby replicas are prod-only (#202)", () => {
  // They roughly DOUBLE the OCU floor, which is the largest standing cost in the
  // stack when the mirror is on.
  const collOf = (stage: string) =>
    Object.values(
      template({ stage }, { enableOpenSearchMirror: "true" }).findResources(
        "AWS::OpenSearchServerless::Collection",
      ),
    )[0]!.Properties as { StandbyReplicas?: string };
  assert.equal(collOf("prod").StandbyReplicas, "ENABLED");
  assert.equal(collOf("dev").StandbyReplicas, "DISABLED");
});

test("the stream consumer's exhausted batches go somewhere, and alarm (#202)", () => {
  // After 3 attempts the records were DROPPED with no destination and no signal,
  // so the mirror diverged from the table silently and stayed diverged.
  const t = template({}, { enableOpenSearchMirror: "true" });
  const mapping = Object.values(t.findResources("AWS::Lambda::EventSourceMapping")).find(
    (m) => (m.Properties as { EventSourceArn?: unknown; StartingPosition?: string }).StartingPosition,
  )!;
  const p = mapping.Properties as Record<string, any>;
  assert.ok(p.DestinationConfig?.OnFailure?.Destination, "no failure destination");
  // One poison record used to fail its whole batch of 100 forever.
  assert.equal(p.BisectBatchOnFunctionError, true);
  assert.deepEqual(p.FunctionResponseTypes, ["ReportBatchItemFailures"]);

  assert.ok(
    Object.keys(t.findResources("AWS::CloudWatch::Alarm")).some((a) =>
      a.startsWith("MirrorDlqNotEmptyAlarm"),
    ),
    "divergence is still silent",
  );
});

test("every Lambda runs a supported runtime (#235)", () => {
  // AWS disabled CREATION of nodejs20.x on 2027-02-01. This project has never
  // been deployed, so a first deploy is all creates — the deprecation would have
  // failed the very first `cdk deploy` anyone ran, at the worst possible moment.
  //
  // Asserted rather than left to a synth warning, because a warning nobody
  // clears is exactly how the previous one survived until it was months from
  // breaking.
  const RETIRED = ["nodejs14.x", "nodejs16.x", "nodejs18.x", "nodejs20.x"];
  const fns = template({}, { enableAnalytics: "true", enableOpenSearchMirror: "true" })
    .findResources("AWS::Lambda::Function");
  const runtimes = new Set<string>();
  for (const [id, f] of Object.entries(fns)) {
    const rt = (f.Properties as { Runtime?: string }).Runtime;
    if (!rt) continue; // CDK's own custom-resource providers
    assert.ok(!RETIRED.includes(rt), `${id} is on ${rt}`);
    // CDK's own singleton providers (auto-delete-objects, log retention) carry a
    // runtime the framework picks and upgrades on its own schedule. They still
    // must not be RETIRED — asserted above — but pinning them to ours would mean
    // forking library code, so they are excluded from the single-runtime check.
    if (id.startsWith("Custom") || id.startsWith("LogRetention")) continue;
    if (rt.startsWith("nodejs")) runtimes.add(rt);
  }
  // One runtime across OUR functions. A mixed set means some handler runs code
  // the others' tests never exercised.
  assert.equal(runtimes.size, 1, `mixed runtimes: ${[...runtimes].join(", ")}`);
  assert.equal([...runtimes][0], "nodejs22.x", "must match `engines` and CI's node-version");
});

// ---------------------------------------------------------------------------
// #199 — Athena guardrails, the dimension tier, and the metering writers
// ---------------------------------------------------------------------------

test("the Athena cost cap is ENFORCED, not suggested (#199)", () => {
  // `bytesScannedCutoffPerQuery` was set but `enforceWorkGroupConfiguration`
  // was not, and it defaults to false. Every guardrail in the workgroup was
  // therefore overridable per query by the same client it exists to bound: the
  // 10 GB cutoff could be raised, and the results location could be pointed
  // anywhere — steering query output, which is a materialised copy of tenant
  // PII, straight out of the analytics bucket.
  const t = template({}, { enableAnalytics: "true" });
  const wg = Object.values(t.findResources("AWS::Athena::WorkGroup"))[0];
  assert.ok(wg, "no workgroup");
  const cfg = (wg!.Properties as { WorkGroupConfiguration: Record<string, any> }).WorkGroupConfiguration;
  assert.equal(cfg.EnforceWorkGroupConfiguration, true);
  assert.equal(cfg.BytesScannedCutoffPerQuery, 10 * 1024 * 1024 * 1024);
});

test("Athena query results are encrypted at rest (#199)", () => {
  // Results are whatever the query selected, written to S3 and kept for the 14
  // days the lifecycle rule allows. That is tenant PII in a second place.
  const t = template({}, { enableAnalytics: "true" });
  const wg = Object.values(t.findResources("AWS::Athena::WorkGroup"))[0]!;
  const result = (wg.Properties as { WorkGroupConfiguration: Record<string, any> }).WorkGroupConfiguration
    .ResultConfiguration;
  assert.ok(result.EncryptionConfiguration, "results inherit whatever the bucket happens to do");
  assert.equal(result.EncryptionConfiguration.EncryptionOption, "SSE_S3");
});

test("the dimension tier is catalogued, not just exported (#199)", () => {
  // The nightly point-in-time export ran forever and produced data NOBODY could
  // query: only `events` was in the Glue catalog. Pure export and storage cost
  // with zero capability.
  const t = template({}, { enableAnalytics: "true" });
  const tables = Object.values(t.findResources("AWS::Glue::Table"));
  const names = tables.map((x) => (x.Properties as { TableInput: { Name: string } }).TableInput.Name);
  assert.deepEqual(names.sort(), ["entities", "events"]);

  const entities = tables.find(
    (x) => (x.Properties as { TableInput: { Name: string } }).TableInput.Name === "entities",
  )!;
  const input = (entities.Properties as { TableInput: Record<string, any> }).TableInput;
  // Partitioned by export day. Without this the 30 retained snapshots union into
  // 30 copies of every row, with no predicate meaning "the latest one".
  assert.deepEqual(input.PartitionKeys, [{ Name: "export_date", Type: "string" }]);
  assert.equal(input.Parameters["projection.enabled"], "true");
  assert.equal(input.Parameters["projection.export_date.type"], "date");
});

test("the export writes to the partition the catalog projects (#199)", () => {
  // Two halves that must agree: the Lambda's S3 prefix and the Glue table's
  // `storage.location.template`. If they drift, the table resolves partitions
  // that hold nothing and every query returns zero rows — silently.
  const t = template({}, { enableAnalytics: "true" });
  const entities = Object.values(t.findResources("AWS::Glue::Table")).find(
    (x) => (x.Properties as { TableInput: { Name: string } }).TableInput.Name === "entities",
  )!;
  const tmpl = flatten(
    (entities.Properties as { TableInput: Record<string, any> }).TableInput.Parameters[
      "storage.location.template"
    ],
  );
  assert.match(tmpl, /\/entities\/export_date=\$\{export_date\}\/$/);
  // …and the domain helper the Lambda calls produces exactly that shape.
  assert.equal(entitiesExportPrefix(new Date("2026-07-27T03:00:00Z")), "entities/export_date=2026-07-27/");
});

test("the event partition projection tracks retention, not a fixed epoch (#199)", () => {
  // Projection ENUMERATES its range rather than discovering partitions. A
  // hardcoded `2024-01-01,NOW` had grown to ~940 projected days, most of them
  // pointing at prefixes the lifecycle rule had already expired — so an
  // unbounded query paid to resolve partitions that could not contain data.
  const t = template({}, { enableAnalytics: "true", analyticsEventRetentionDays: "45" });
  const events = Object.values(t.findResources("AWS::Glue::Table")).find(
    (x) => (x.Properties as { TableInput: { Name: string } }).TableInput.Name === "events",
  )!;
  const range = (events.Properties as { TableInput: Record<string, any> }).TableInput.Parameters[
    "projection.event_date.range"
  ];
  // The SAME number the bucket expires on, so the projection ends where the data does.
  assert.equal(range, "NOW-45DAYS,NOW");
});

test("something actually writes a usage record (#199)", () => {
  // The Usage screen was permanently $0 — not because the cost model was wrong,
  // but because `usageIngestHandler` was wired to no route and no schedule, so
  // the GET routes always answered `null`.
  const t = template({});
  const fns = t.findResources("AWS::Lambda::Function");
  const meter = Object.keys(fns).find((k) => k.startsWith("UsageMeterFn"));
  assert.ok(meter, "nothing computes usage on a schedule");

  const rules = Object.values(t.findResources("AWS::Events::Rule"));
  const scheduled = rules.find((r) =>
    ((r.Properties as { Targets?: { Arn?: unknown }[] }).Targets ?? []).some((tg) =>
      flatten(tg.Arn).includes("UsageMeterFn"),
    ),
  );
  assert.ok(scheduled, "the meter exists but nothing invokes it");
  assert.ok((scheduled!.Properties as { ScheduleExpression?: string }).ScheduleExpression);

  // And the AWS-side half stays invoke-only — it takes Cost Explorer figures
  // from the operator's account, not from a console user, so it is reachable by
  // name rather than by an authenticated route.
  assert.ok(Object.keys(fns).some((k) => k.startsWith("UsageIngestFn")));
  assert.ok("UsageIngestFunctionName" in (t.toJSON().Outputs ?? {}), "and no way to find it");
});

// ---------------------------------------------------------------------------
// #234 — ConfirmSecret rotation, and the unsubscribe link people actually click
// ---------------------------------------------------------------------------

test("the visible unsubscribe link answers a browser, not just a mailbox provider (#234)", () => {
  // The `unsubscribe_url` merge tag and the RFC 8058 `List-Unsubscribe` header
  // are the SAME url. The route was POST-only, so the header worked and the
  // link in the body of every message — the one a human clicks — returned 405.
  const routes = Object.values(template().findResources("AWS::ApiGatewayV2::Route")).map((r) =>
    flatten((r.Properties as { RouteKey: unknown }).RouteKey),
  );
  assert.ok(routes.includes("POST /unsubscribe"), "one-click POST is gone");
  assert.ok(routes.includes("GET /unsubscribe"), "a browser click still 405s");
});

test("ConfirmSecret has a rotation schedule, and its own function (#234)", () => {
  // A RotationSchedule on a SINGLE-key secret would be worse than none: it would
  // invalidate every outstanding opt-in and unsubscribe link on a schedule,
  // quietly. So the presence of a schedule is only correct alongside a rotation
  // function that appends to a keyring rather than replacing it.
  const t = template();
  const schedules = t.findResources("AWS::SecretsManager::RotationSchedule");
  assert.equal(Object.keys(schedules).length, 1, "exactly one secret rotates");
  const cfg = Object.values(schedules)[0]!.Properties as {
    RotationLambdaARN?: unknown;
    RotationRules?: { AutomaticallyAfterDays?: number; ScheduleExpression?: string };
  };
  assert.ok(cfg.RotationLambdaARN, "a schedule with no function does nothing");
  assert.ok(flatten(cfg.RotationLambdaARN).includes("ConfirmSecretRotationFn"));

  // Yearly, not the 30-day default: every rotation permanently adds a key to the
  // ring, and unsubscribe tokens live five years.
  const rules = cfg.RotationRules ?? {};
  const yearly =
    rules.AutomaticallyAfterDays === 365 || /365 days|rate\(365 days\)/.test(rules.ScheduleExpression ?? "");
  assert.ok(yearly, `rotation cadence is not yearly: ${JSON.stringify(rules)}`);
});

test("the rotation function can move a staging label (#234)", () => {
  // grantRead/grantWrite do NOT cover UpdateSecretVersionStage. Without it,
  // `finishSecret` fails, AWSPENDING is never promoted, and the rotation retries
  // and fails forever — with the secret itself untouched, so nothing looks wrong.
  const t = template();
  const grants = Object.entries(t.findResources("AWS::IAM::Policy"))
    .filter(([id]) => id.startsWith("ConfirmSecretRotationFn"))
    .flatMap(([, p]) =>
      ((p.Properties as { PolicyDocument: { Statement: Record<string, unknown>[] } }).PolicyDocument
        .Statement ?? []).flatMap((st) => actionsOf(st)),
    );
  assert.ok(grants.includes("secretsmanager:UpdateSecretVersionStage"), "finishSecret cannot promote");
  assert.ok(grants.includes("secretsmanager:PutSecretValue"), "createSecret cannot stage");
});

test("the diversion alarm names BOTH causes, since one is not replayable (#236)", () => {
  // `ExecuteProcessingFailure.Records` fires for a transform bug and for
  // Firehose's 500-active-partition quota alike, and the two need opposite
  // responses: the first is fixed and replayed, the second CANNOT be replayed —
  // the replay function re-runs the same transform into the same partitions and
  // hits the same wall — and needs a quota increase. An operator paged with only
  // "replay them" will do the thing that cannot work.
  const t = template({}, { enableAnalytics: "true" });
  const alarm = Object.values(t.findResources("AWS::CloudWatch::Alarm")).find(
    (a) => (a.Properties as { MetricName?: string }).MetricName === "ExecuteProcessingFailure.Records",
  )!;
  const desc = (alarm.Properties as { AlarmDescription: string }).AlarmDescription;
  assert.match(desc, /partition/i, "the quota cause is not mentioned");
  assert.match(desc, /replay/i, "the transform cause has no next step");
  assert.match(desc, /CANNOT recover/i, "nothing warns that replay is useless for the quota case");
});
