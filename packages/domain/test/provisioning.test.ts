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
  memStores,
  type ProvisioningProviders,
} from "@addressium/domain";

const input: schemas.CreateOrgInput = {
  name: "Summit Daily",
  primaryDomain: "summitdaily.com",
  siteDomain: "summitdaily.com",
  region: "us-east-1",
  defaultTimezone: "America/Denver",
  subscriberPool: { mode: "create" },
  dedicatedIp: false,
  suppressionScope: "hybrid",
};

function fakeProviders(overrides: Partial<ProvisioningProviders> = {}): ProvisioningProviders {
  return {
    ensureSubscriberPool: async () => ({ poolId: "pool-123" }),
    createSigningKey: async () => ({ kmsKeyArn: "arn:aws:kms:...:key/abc", kid: "abc" }),
    ensureSesDomainIdentity: async () => ({
      configSet: "addressium-summit-daily",
      dkimTokens: ["tok1", "tok2"],
      verificationStatus: "pending",
    }),
    ...overrides,
  };
}

test("slugifyOrgId derives a DNS-safe id from the name", () => {
  assert.equal(slugifyOrgId("Summit Daily"), "summit-daily");
  assert.equal(slugifyOrgId("  Vail Daily!! "), "vail-daily");
});

test("provision assembles the org record and returns DKIM/SPF/DMARC DNS", async () => {
  const stores = memStores();
  const result = await provisionOrganization(stores, fakeProviders(), input);

  assert.equal(result.alreadyExisted, false);
  assert.equal(result.org.orgId, "summit-daily");
  assert.equal(result.org.subscriberPoolId, "pool-123");
  assert.equal(result.org.magicLink.kmsKeyArn, "arn:aws:kms:...:key/abc");
  assert.equal(result.org.magicLink.audience, "summitdaily.com");
  assert.equal(result.org.defaultTimezone, "America/Denver");
  assert.equal(result.org.ipMode, "shared");
  assert.equal(result.org.setupComplete, false); // SES pending

  const dkim = result.dns.filter((r) => r.type === "CNAME");
  assert.equal(dkim.length, 2);
  assert.match(dkim[0]!.name, /_domainkey\.summitdaily\.com$/);
  assert.ok(result.dns.some((r) => r.value.startsWith("v=spf1")));
  assert.ok(result.dns.some((r) => r.name.startsWith("_dmarc.")));

  // Persisted for the tokens service + sender to resolve.
  assert.deepEqual(await stores.organizations.get("summit-daily"), result.org);
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
