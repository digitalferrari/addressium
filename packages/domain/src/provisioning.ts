/**
 * Add-organization provisioning (docs/ARCHITECTURE.md §4.11, #14).
 *
 * Orchestrates the silo bring-up: create or link the subscriber Cognito pool,
 * create the per-org KMS signing key, ensure the SES domain identity + config
 * set, assemble the Organization record (incl. defaultTimezone + magic-link
 * config), and return the DNS records the operator must publish. The AWS calls
 * are behind a provider port so this logic is pure and unit-testable, and the
 * operation is idempotent on orgId.
 */
import type { Organization, schemas } from "@addressium/core";
import type { Stores } from "./ports.js";

type CreateOrgInput = schemas.CreateOrgInput;

export interface SubscriberPoolSpec {
  mode: "create" | "link";
  poolId?: string;
}

export interface SigningKey {
  kmsKeyArn: string;
  kid: string;
}

export interface SesIdentity {
  configSet: string;
  dkimTokens: string[];
  verificationStatus: "pending" | "verified";
}

/** The AWS side effects, injected so provisioning stays testable. */
export interface ProvisioningProviders {
  ensureSubscriberPool(orgId: string, spec: SubscriberPoolSpec): Promise<{ poolId: string }>;
  createSigningKey(orgId: string): Promise<SigningKey>;
  ensureSesDomainIdentity(orgId: string, domain: string): Promise<SesIdentity>;
}

export interface DnsRecord {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
}

export interface ProvisionResult {
  org: Organization;
  /** Records the operator adds to their DNS to pass DKIM/SPF/DMARC. */
  dns: DnsRecord[];
  alreadyExisted: boolean;
}

/** Derive a stable, DNS-safe org id from the display name. */
export function slugifyOrgId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // Trim leading/trailing dashes. The `(?<!-)` on the trailing branch removes
    // the ambiguity that made `-+$` polynomial on interior dash runs (#js-redos).
    .replace(/^-+|(?<!-)-+$/g, "");
  if (!slug) throw new Error("cannot derive org id from name");
  return slug;
}

function dnsRecords(domain: string, dkimTokens: string[]): DnsRecord[] {
  const dkim: DnsRecord[] = dkimTokens.map((t) => ({
    type: "CNAME",
    name: `${t}._domainkey.${domain}`,
    value: `${t}.dkim.amazonses.com`,
  }));
  return [
    ...dkim,
    { type: "TXT", name: domain, value: "v=spf1 include:amazonses.com ~all" },
    {
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: "v=DMARC1; p=none; rua=mailto:dmarc@" + domain,
    },
  ];
}

export async function provisionOrganization(
  stores: Stores,
  providers: ProvisioningProviders,
  input: CreateOrgInput,
  opts: { orgId?: string } = {},
): Promise<ProvisionResult> {
  const orgId = opts.orgId ?? slugifyOrgId(input.name);

  // Idempotent: re-running returns the existing org (never double-provisions).
  const existing = await stores.organizations.get(orgId);
  if (existing) {
    return { org: existing, dns: dnsRecords(input.primaryDomain, []), alreadyExisted: true };
  }

  const pool = await providers.ensureSubscriberPool(orgId, input.subscriberPool);
  const key = await providers.createSigningKey(orgId);
  const ses = await providers.ensureSesDomainIdentity(orgId, input.primaryDomain);

  const domains = [...new Set([input.primaryDomain, input.siteDomain])];
  const org: Organization = {
    orgId,
    name: input.name,
    domains,
    subscriberPoolId: pool.poolId,
    magicLink: {
      kmsKeyArn: key.kmsKeyArn,
      kid: key.kid,
      issuer: `https://${input.siteDomain}/${orgId}`,
      audience: input.siteDomain,
    },
    sesConfigSet: ses.configSet,
    ipMode: input.dedicatedIp ? "dedicated" : "shared",
    suppressionScope: input.suppressionScope,
    environment: input.environment,
    ...(input.devAllowlist ? { devAllowlist: input.devAllowlist } : {}),
    defaultTimezone: input.defaultTimezone,
    // Not complete until SES reports the domain identity verified (async, DNS-based).
    setupComplete: ses.verificationStatus === "verified",
  };
  await stores.organizations.put(org);
  return { org, dns: dnsRecords(input.primaryDomain, ses.dkimTokens), alreadyExisted: false };
}
