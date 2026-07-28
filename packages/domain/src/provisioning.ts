/**
 * Add-organization provisioning (docs/ARCHITECTURE.md §4.11, #14).
 *
 * Orchestrates the silo bring-up: ensure the SES domain identity + config set,
 * assemble the Organization record (incl. defaultTimezone), and return the DNS
 * records the operator must publish. With magic links on it additionally links
 * the operator's existing subscriber Cognito pool and creates the per-org KMS
 * signing key; with them off it does neither, and the org is a pure sender. The
 * AWS calls are behind a provider port so this logic is pure and unit-testable,
 * and the operation is idempotent on orgId.
 */
import type { Organization, schemas } from "@addressium/core";
import { schemas as s } from "@addressium/core";
import type { Stores } from "./ports.js";
import { defaultAlertConfig } from "./alerts.js";

type CreateOrgInput = schemas.CreateOrgInput;

/**
 * The operator's EXISTING Cognito user pool. Link-only by design: a pool has
 * far more configuration than addressium can sensibly own, and it is the
 * operator's own directory (§4.10).
 */
export interface SubscriberPoolSpec {
  poolId: string;
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
  /** Validate the operator's pool and return its id. Never creates a pool. */
  linkSubscriberPool(orgId: string, spec: SubscriberPoolSpec): Promise<{ poolId: string }>;
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
  // Whichever way the id arrived — an explicit override or a slug derived from
  // the display name — it goes on to be interpolated into S3 keys, a Secrets
  // Manager name, a KMS alias, an OpenSearch index and the magic-link `issuer`.
  // Checked HERE as well as at the handler because those namespaces are not
  // ours, and a caller that reaches this function by another route (a script, a
  // future queue consumer) must not be able to skip it. A long display name can
  // also slug past 64 characters; truncating would silently hand org B the org A
  // record on the idempotency check, so it fails loudly instead (#196).
  const orgId = s.idSchema.parse(opts.orgId ?? slugifyOrgId(input.name));

  // Idempotent: re-running returns the existing org (never double-provisions).
  const existing = await stores.organizations.get(orgId);
  if (existing) {
    return { org: existing, dns: dnsRecords(input.primaryDomain, []), alreadyExisted: true };
  }

  // The pool link and the signing key exist ONLY to serve magic-link tokens, so
  // an org with the feature off gets neither — addressium never touches a user
  // pool or a KMS key for it (§4.9). SES stays unconditional: it is how mail
  // goes out in both modes.
  let subscriberPoolId: string | undefined;
  let magicLink: Organization["magicLink"];
  if (input.magicLinks) {
    // createOrgSchema enforces this at the API boundary; re-asserted because a
    // token minted without a pool sub is one no paywall can resolve, and this
    // function is also called directly from scripts and tests.
    if (!input.subscriberPool) throw new Error("magic links require a linked subscriber pool");
    const pool = await providers.linkSubscriberPool(orgId, input.subscriberPool);
    const key = await providers.createSigningKey(orgId);
    subscriberPoolId = pool.poolId;
    magicLink = {
      kmsKeyArn: key.kmsKeyArn,
      kid: key.kid,
      issuer: `https://${input.siteDomain}/${orgId}`,
      audience: input.siteDomain,
    };
  }
  const ses = await providers.ensureSesDomainIdentity(orgId, input.primaryDomain);

  const domains = [...new Set([input.primaryDomain, input.siteDomain])];
  const org: Organization = {
    orgId,
    name: input.name,
    domains,
    // Omitted, not undefined, when the feature is off — absence IS the flag.
    ...(subscriberPoolId ? { subscriberPoolId } : {}),
    ...(magicLink ? { magicLink } : {}),
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

  // Deliverability protection is on from the first send (#217). Before this,
  // every org provisioned with no AlertConfig, checkDeliverability
  // short-circuited on the missing record, and the auto-halt was unreachable on
  // every real install. The operator can tune or disable the rules; they cannot
  // accidentally start with none.
  if (!(await stores.alerts.get(orgId))) {
    await stores.alerts.put(defaultAlertConfig(orgId, input.alertTopicArn));
  }

  return { org, dns: dnsRecords(input.primaryDomain, ses.dkimTokens), alreadyExisted: false };
}
