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
import {
  PRIMARY_TEST_MERGE_TAGS,
  PRIMARY_TEST_TEMPLATE_ID,
  PRIMARY_TEST_TEMPLATE_NAME,
  primaryTestSource,
} from "./seed-template.js";

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
  /**
   * The custom MAIL FROM subdomain (#200), e.g. `bounce.example.com`.
   *
   * Without one the envelope sender — the Return-Path, which is what SPF
   * actually authenticates — stays on `amazonses.com`. SPF then passes for
   * Amazon's domain rather than the publisher's, so it is not ALIGNED with the
   * From header, and DMARC ignores it entirely. DKIM alignment alone would still
   * carry DMARC, but a message has only that one leg to stand on: a forwarder
   * that breaks the DKIM signature takes the whole authentication result with
   * it, where an aligned SPF pass would have survived.
   */
  mailFromDomain?: string;
  /** Region-specific MX host the MAIL FROM subdomain must point at. */
  mailFromMxHost?: string;
}

/**
 * DMARC enforcement level for the published `_dmarc` record (#200).
 *
 * `none` is monitor-only: it asks receivers to REPORT failures and to do nothing
 * about them, so a domain published at `p=none` forever has DMARC records but no
 * DMARC protection — anyone can spoof the domain and every receiver will still
 * deliver it. It is the correct STARTING point and the wrong resting point.
 */
export type DmarcPolicy = "none" | "quarantine" | "reject";

/** The AWS side effects, injected so provisioning stays testable. */
export interface ProvisioningProviders {
  /** Validate the operator's pool and return its id. Never creates a pool. */
  linkSubscriberPool(orgId: string, spec: SubscriberPoolSpec): Promise<{ poolId: string }>;
  createSigningKey(orgId: string): Promise<SigningKey>;
  ensureSesDomainIdentity(orgId: string, domain: string): Promise<SesIdentity>;
}

export interface DnsRecord {
  type: "CNAME" | "TXT" | "MX";
  name: string;
  value: string;
  /** Why this record exists and what breaks without it — shown in the console. */
  note?: string;
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

/** The custom MAIL FROM subdomain for a sending domain (#200). */
export const mailFromDomainFor = (domain: string): string => `bounce.${domain}`;

/** The MX host a custom MAIL FROM subdomain must point at, per region (#200). */
export const mailFromMxHostFor = (region: string): string => `feedback-smtp.${region}.amazonses.com`;

/**
 * The records the operator publishes so mail from this domain authenticates
 * (§4.11, #200).
 *
 * The MAIL FROM pair is the part that used to be missing. SPF authenticates the
 * ENVELOPE sender, not the From header — so with SES's default return path the
 * SPF that passes belongs to `amazonses.com`, is unaligned with the visible
 * From, and contributes nothing to DMARC. Publishing an MX and an SPF record on
 * a `bounce.` subdomain moves the envelope onto the publisher's own domain and
 * makes that pass count.
 */
export function dnsRecords(
  domain: string,
  dkimTokens: string[],
  opts: { dmarcPolicy?: DmarcPolicy; mailFromDomain?: string; mailFromMxHost?: string } = {},
): DnsRecord[] {
  const dkim: DnsRecord[] = dkimTokens.map((t) => ({
    type: "CNAME",
    name: `${t}._domainkey.${domain}`,
    value: `${t}.dkim.amazonses.com`,
    note: "DKIM. Signs the message body; the only authentication that survives most forwarding.",
  }));
  const policy = opts.dmarcPolicy ?? "none";
  const records: DnsRecord[] = [
    ...dkim,
    {
      type: "TXT",
      name: domain,
      value: "v=spf1 include:amazonses.com ~all",
      note: "SPF for the From domain. Note this authenticates the ENVELOPE sender, which is why the MAIL FROM records below matter.",
    },
  ];
  if (opts.mailFromDomain && opts.mailFromMxHost) {
    records.push(
      {
        type: "MX",
        name: opts.mailFromDomain,
        value: `10 ${opts.mailFromMxHost}`,
        // BehaviorOnMxFailure is USE_DEFAULT_VALUE, so a missing MX degrades to
        // the amazonses.com return path rather than halting the org's mail. That
        // is deliberate — but it also means a forgotten record fails QUIETLY,
        // losing SPF alignment with nothing visibly broken.
        note: "Custom MAIL FROM. Receives bounce/complaint reports for the envelope sender. Without it SES silently falls back to amazonses.com and SPF stops aligning.",
      },
      {
        type: "TXT",
        name: opts.mailFromDomain,
        value: "v=spf1 include:amazonses.com ~all",
        note: "SPF for the MAIL FROM subdomain. This is the record DMARC's SPF leg actually checks.",
      },
    );
  }
  records.push({
    type: "TXT",
    name: `_dmarc.${domain}`,
    value: `v=DMARC1; p=${policy}; rua=mailto:dmarc@${domain}`,
    note:
      policy === "none"
        ? "DMARC, MONITOR ONLY. p=none asks receivers to report failures and to do nothing about them — the domain is still spoofable. Read the rua reports until legitimate mail passes, then move to p=quarantine and finally p=reject."
        : `DMARC, ENFORCING (p=${policy}). Confirm every legitimate sender for this domain — including anything outside addressium — passes DKIM or aligned SPF before leaving this in place.`,
  });
  return records;
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
    return {
      org: existing,
      dns: dnsRecords(input.primaryDomain, [], {
        dmarcPolicy: existing.dmarcPolicy ?? "none",
        mailFromDomain: existing.mailFromDomain ?? mailFromDomainFor(input.primaryDomain),
        mailFromMxHost: mailFromMxHostFor(input.region),
      }),
      alreadyExisted: true,
    };
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
    ...(ses.mailFromDomain ? { mailFromDomain: ses.mailFromDomain } : {}),
    dmarcPolicy: input.dmarcPolicy,
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

  // The canonical smoke-test template, in all three modes (#204). Seeded rather
  // than documented as a copy-paste, because the point of a known-good body is
  // that every deployment has THE SAME one — a fixture an operator has to paste
  // is a fixture that drifts, and the first thing anyone does with a new org is
  // send a test.
  for (const mode of ["raw_html", "mjml", "visual"] as const) {
    const templateId = mode === "raw_html" ? PRIMARY_TEST_TEMPLATE_ID : `${PRIMARY_TEST_TEMPLATE_ID}-${mode}`;
    if (await stores.templates.get(orgId, templateId)) continue;
    await stores.templates.put({
      orgId,
      templateId,
      name: `${PRIMARY_TEST_TEMPLATE_NAME} — ${mode}`,
      mode,
      source: primaryTestSource(mode),
      version: 1,
      mergeTags: [...PRIMARY_TEST_MERGE_TAGS],
      adSlots: [],
    });
  }

  return {
    org,
    dns: dnsRecords(input.primaryDomain, ses.dkimTokens, {
      dmarcPolicy: input.dmarcPolicy,
      ...(ses.mailFromDomain ? { mailFromDomain: ses.mailFromDomain } : {}),
      ...(ses.mailFromMxHost ? { mailFromMxHost: ses.mailFromMxHost } : {}),
    }),
    alreadyExisted: false,
  };
}
