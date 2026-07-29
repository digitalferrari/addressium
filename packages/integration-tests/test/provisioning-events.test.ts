/**
 * Regression (#208): provisioning created the SES configuration set but never an
 * event destination. A config set with no destination publishes NOTHING, so the
 * whole event plane was dead at the source — the #184 unwrap/tagging fix could
 * never be observed, counters stayed zero, suppression never auto-triggered and
 * the deliverability halt could not fire.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AwsProvisioningProviders } from "@addressium/adapters-aws";

/** Records the command names + inputs sent to a client. */
function fakeClient(behavior: Record<string, () => unknown> = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    // The real SESv2Client exposes its resolved region here; the MAIL FROM MX
    // host is region-specific (#200), so the fake has to carry one too.
    config: { region: "us-east-1" },
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      const b = behavior[name];
      if (b) return b();
      return {};
    },
  };
}

function providers(sesBehavior: Record<string, () => unknown> = {}) {
  const ses = fakeClient({
    // Identity already exists, so the happy path doesn't try to create one.
    GetEmailIdentityCommand: () => ({ DkimAttributes: { Tokens: ["t1"] }, VerifiedForSendingStatus: true }),
    ...sesBehavior,
  });
  const p = new AwsProvisioningProviders(
    fakeClient() as never,
    ses as never,
    fakeClient() as never,
  );
  return { p, ses };
}

test("provisioning attaches an SNS event destination to the org's config set", async () => {
  process.env.SES_EVENTS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:SesEventsTopic";
  const { p, ses } = providers();

  const res = await p.ensureSesDomainIdentity("acme", "mail.acme.example");
  assert.equal(res.configSet, "addressium-acme");

  const create = ses.calls.find((c) => c.name === "CreateConfigurationSetEventDestinationCommand");
  assert.ok(create, "must create an event destination — without it SES publishes nothing");
  const dest = create.input.EventDestination as {
    Enabled: boolean;
    SnsDestination: { TopicArn: string };
    MatchingEventTypes: string[];
  };
  assert.equal(dest.Enabled, true);
  assert.equal(dest.SnsDestination.TopicArn, process.env.SES_EVENTS_TOPIC_ARN);
  // The four the handler acts on today, plus DELIVERY which delivery-rate
  // accuracy depends on.
  for (const t of ["BOUNCE", "COMPLAINT", "OPEN", "CLICK", "DELIVERY"]) {
    assert.ok(dest.MatchingEventTypes.includes(t), `must publish ${t}`);
  }
});

test("re-provisioning an existing org updates rather than failing", async () => {
  process.env.SES_EVENTS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:SesEventsTopic";
  const { p, ses } = providers({
    CreateConfigurationSetCommand: () => {
      throw Object.assign(new Error("exists"), { name: "AlreadyExistsException" });
    },
    CreateConfigurationSetEventDestinationCommand: () => {
      throw Object.assign(new Error("exists"), { name: "AlreadyExistsException" });
    },
  });

  await p.ensureSesDomainIdentity("acme", "mail.acme.example");
  assert.ok(
    ses.calls.some((c) => c.name === "UpdateConfigurationSetEventDestinationCommand"),
    "an already-present destination must be updated, not left to throw",
  );
});

test("a missing topic ARN does not abort provisioning", async () => {
  delete process.env.SES_EVENTS_TOPIC_ARN;
  const { p, ses } = providers();
  // The org must still be provisioned — the destination is logged as missing
  // rather than taking the whole org-creation flow down.
  const res = await p.ensureSesDomainIdentity("acme", "mail.acme.example");
  assert.equal(res.configSet, "addressium-acme");
  assert.equal(
    ses.calls.some((c) => c.name === "CreateConfigurationSetEventDestinationCommand"),
    false,
  );
});

// ---------------------------------------------------------------------------
// #200 — envelope-sender alignment and SES-side suppression
// ---------------------------------------------------------------------------

test("provisioning puts the envelope sender on the org's own domain", async () => {
  // SPF authenticates the ENVELOPE sender, not the visible From. Without a
  // custom MAIL FROM the return path stays *.amazonses.com, so the SPF that
  // passes belongs to Amazon, is unaligned with the From header, and DMARC
  // discards it — leaving DKIM as the message's only authentication leg.
  process.env.SES_EVENTS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:SesEventsTopic";
  const { p, ses } = providers();

  const res = await p.ensureSesDomainIdentity("acme", "mail.acme.example");
  assert.equal(res.mailFromDomain, "bounce.mail.acme.example");
  assert.equal(res.mailFromMxHost, "feedback-smtp.us-east-1.amazonses.com");

  const put = ses.calls.find((c) => c.name === "PutEmailIdentityMailFromAttributesCommand");
  assert.ok(put, "no custom MAIL FROM — SPF cannot align");
  assert.equal(put.input.MailFromDomain, "bounce.mail.acme.example");
  // USE_DEFAULT_VALUE, not REJECT_MESSAGE: a DNS record the operator has not
  // published yet must degrade to the amazonses.com return path, not halt the
  // org's entire mail flow.
  assert.equal(put.input.BehaviorOnMxFailure, "USE_DEFAULT_VALUE");
});

test("a MAIL FROM failure does not abort provisioning", async () => {
  // Mail still sends on the default return path. Losing SPF alignment is worth
  // reporting; it is not worth failing the org's creation over.
  process.env.SES_EVENTS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:SesEventsTopic";
  const { p } = providers({
    PutEmailIdentityMailFromAttributesCommand: () => {
      throw new Error("nope");
    },
  });
  const res = await p.ensureSesDomainIdentity("acme", "mail.acme.example");
  assert.equal(res.configSet, "addressium-acme");
});

test("the config set carries SES-side bounce/complaint suppression", async () => {
  // Ours only knows about bounces this deployment has processed. SES's list
  // stops the send at the API boundary, before it becomes a bounce — which
  // covers the window between a bounce arriving and our handler recording it,
  // and any path that skips our own check. Re-mailing an address SES already
  // knows is dead is a direct reputation cost.
  process.env.SES_EVENTS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:SesEventsTopic";
  const { p, ses } = providers();
  await p.ensureSesDomainIdentity("acme", "mail.acme.example");

  const create = ses.calls.find((c) => c.name === "CreateConfigurationSetCommand")!;
  const reasons = (create.input.SuppressionOptions as { SuppressedReasons: string[] }).SuppressedReasons;
  assert.deepEqual([...reasons].sort(), ["BOUNCE", "COMPLAINT"]);
});

test("an org provisioned before #200 gets suppression added on re-provision", async () => {
  // Its config set already exists, so CreateConfigurationSet throws and the
  // suppression options in it are never applied. Re-provisioning has to bring
  // the existing set up to date rather than skip straight past it.
  process.env.SES_EVENTS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:SesEventsTopic";
  const { p, ses } = providers({
    CreateConfigurationSetCommand: () => {
      throw Object.assign(new Error("exists"), { name: "AlreadyExistsException" });
    },
  });
  await p.ensureSesDomainIdentity("acme", "mail.acme.example");

  const put = ses.calls.find((c) => c.name === "PutConfigurationSetSuppressionOptionsCommand");
  assert.ok(put, "an existing config set keeps whatever suppression it was created with — none");
  assert.deepEqual([...(put.input.SuppressedReasons as string[])].sort(), ["BOUNCE", "COMPLAINT"]);
});
