/**
 * Add-organization provisioning: orchestrates pool/key/SES, assembles the org
 * record (magic-link config, timezone, ip mode), returns DKIM/SPF/DMARC DNS, and
 * is idempotent on org id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { schemas } from "@addressium/core";
import {
  provisionOrganization,
  slugifyOrgId,
  dnsRecords,
  mailFromDomainFor,
  mailFromMxHostFor,
  memStores,
  type ProvisioningProviders,
} from "@addressium/domain";

const input: schemas.CreateOrgInput = {
  name: "Northwind Times",
  primaryDomain: "northwindtimes.example",
  siteDomain: "northwindtimes.example",
  region: "us-east-1",
  defaultTimezone: "America/Denver",
  magicLinks: true,
  subscriberPool: { poolId: "pool-123" },
  dedicatedIp: false,
  dmarcPolicy: "none",
    suppressionScope: "hybrid",
  environment: "prod",
};

function fakeProviders(overrides: Partial<ProvisioningProviders> = {}): ProvisioningProviders {
  return {
    linkSubscriberPool: async () => ({ poolId: "pool-123" }),
    createSigningKey: async () => ({ kmsKeyArn: "arn:aws:kms:...:key/abc", kid: "abc" }),
    ensureSesDomainIdentity: async () => ({
      configSet: "addressium-northwind-times",
      dkimTokens: ["tok1", "tok2"],
      verificationStatus: "pending",
    }),
    ...overrides,
  };
}

test("slugifyOrgId derives a DNS-safe id from the name", () => {
  assert.equal(slugifyOrgId("Northwind Times"), "northwind-times");
  assert.equal(slugifyOrgId("  Lakeside Ledger!! "), "lakeside-ledger");
});

test("provision assembles the org record and returns DKIM/SPF/DMARC DNS", async () => {
  const stores = memStores();
  const result = await provisionOrganization(stores, fakeProviders(), input);

  assert.equal(result.alreadyExisted, false);
  assert.equal(result.org.orgId, "northwind-times");
  assert.equal(result.org.subscriberPoolId, "pool-123");
  assert.equal(result.org.magicLink?.kmsKeyArn, "arn:aws:kms:...:key/abc");
  assert.equal(result.org.magicLink?.audience, "northwindtimes.example");
  assert.equal(result.org.defaultTimezone, "America/Denver");
  assert.equal(result.org.ipMode, "shared");
  assert.equal(result.org.environment, "prod");
  assert.equal(result.org.setupComplete, false); // SES pending

  const dkim = result.dns.filter((r) => r.type === "CNAME");
  assert.equal(dkim.length, 2);
  assert.match(dkim[0]!.name, /_domainkey\.northwindtimes\.example$/);
  assert.ok(result.dns.some((r) => r.value.startsWith("v=spf1")));
  assert.ok(result.dns.some((r) => r.name.startsWith("_dmarc.")));

  // Persisted for the tokens service + sender to resolve.
  assert.deepEqual(await stores.organizations.get("northwind-times"), result.org);
});

test("setupComplete flips true when SES reports verified", async () => {
  const stores = memStores();
  const providers = fakeProviders({
    ensureSesDomainIdentity: async () => ({
      configSet: "cs",
      dkimTokens: [],
      verificationStatus: "verified",
    }),
  });
  const result = await provisionOrganization(stores, providers, input);
  assert.equal(result.org.setupComplete, true);
});

test("a dev org is provisioned on the same workflows but flagged environment=dev", async () => {
  const stores = memStores();
  const result = await provisionOrganization(stores, fakeProviders(), {
    ...input,
    name: "Dev Summit Daily",
    primaryDomain: "devsummitdaily.example",
    siteDomain: "devsummitdaily.example",
    environment: "dev",
  });
  assert.equal(result.org.environment, "dev");
  // Same silo shape as prod — its own config set + magic-link audience.
  assert.equal(result.org.magicLink?.audience, "devsummitdaily.example");
});

test("provision is idempotent — re-running returns the existing org", async () => {
  const stores = memStores();
  let keyCalls = 0;
  const providers = fakeProviders({
    createSigningKey: async () => {
      keyCalls++;
      return { kmsKeyArn: "arn", kid: "k" };
    },
  });
  await provisionOrganization(stores, providers, input);
  const second = await provisionOrganization(stores, providers, input);
  assert.equal(second.alreadyExisted, true);
  assert.equal(keyCalls, 1); // no second KMS key minted
});

// ---------------------------------------------------------------------------
// #200 — the DNS the operator has to publish for mail to authenticate
// ---------------------------------------------------------------------------

test("the MAIL FROM pair is published, not just DKIM and SPF", async () => {
  // Without the MX + SPF pair on the bounce subdomain, the envelope sender stays
  // on amazonses.com and the SPF pass is unaligned — DMARC does not count it.
  const records = dnsRecords("northwindtimes.example", ["t1"], {
    mailFromDomain: "bounce.northwindtimes.example",
    mailFromMxHost: "feedback-smtp.us-east-1.amazonses.com",
  });
  const mx = records.find((r) => r.type === "MX");
  assert.ok(mx, "no MX record — SES silently falls back to the default return path");
  assert.equal(mx.name, "bounce.northwindtimes.example");
  assert.equal(mx.value, "10 feedback-smtp.us-east-1.amazonses.com");

  // The MAIL FROM subdomain needs its OWN SPF record. The one on the From
  // domain does not cover it, and that subdomain record is the one DMARC's SPF
  // leg actually checks.
  const spf = records.filter((r) => r.type === "TXT" && r.value.startsWith("v=spf1"));
  assert.equal(spf.length, 2);
  assert.ok(spf.some((r) => r.name === "bounce.northwindtimes.example"));
});

test("DMARC defaults to monitor-only and SAYS that it is monitor-only", async () => {
  // p=none publishes DMARC records without DMARC protection: receivers report
  // failures and deliver the mail anyway, so the domain is still spoofable. A
  // record that looks like protection and is not needs to say so where the
  // operator reads it, not only in the docs.
  const [dmarc] = dnsRecords("northwindtimes.example", []).filter((r) => r.name.startsWith("_dmarc."));
  assert.match(dmarc!.value, /p=none/);
  assert.match(dmarc!.note!, /MONITOR ONLY/);
  assert.match(dmarc!.note!, /quarantine/);
});

test("an enforcing DMARC policy is emitted when asked for", async () => {
  const [dmarc] = dnsRecords("northwindtimes.example", [], { dmarcPolicy: "reject" }).filter((r) =>
    r.name.startsWith("_dmarc."),
  );
  assert.match(dmarc!.value, /p=reject/);
  // And warns about the senders outside addressium that this will now break.
  assert.match(dmarc!.note!, /outside addressium/);
});

test("the MAIL FROM host is region-specific", async () => {
  // Publishing the us-east-1 host for a eu-west-1 identity means the MX never
  // resolves and SES falls back — quietly, because BehaviorOnMxFailure is
  // USE_DEFAULT_VALUE.
  assert.equal(mailFromMxHostFor("eu-west-1"), "feedback-smtp.eu-west-1.amazonses.com");
  assert.equal(mailFromDomainFor("northwindtimes.example"), "bounce.northwindtimes.example");
});
