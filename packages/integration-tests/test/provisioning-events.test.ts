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
