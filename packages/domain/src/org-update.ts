/**
 * Correcting an organization's settings after provisioning (#294).
 *
 * Deliberately a NARROW allowlist, not a general `PATCH /orgs/{org}`. Most
 * fields on an `Organization` are provisioned infrastructure — `sesConfigSet`,
 * `magicLink`, `subscriberPoolId` — and editing them from a settings form
 * would not reconfigure anything, it would just make the record disagree with
 * AWS. Two more are excluded for their own reasons:
 *
 *   - `suppressionScope` changes WHO COUNTS as suppressed, retroactively. That
 *     is a compliance decision, not a setting.
 *   - `ipMode` / `dedicatedIpPoolName` carry a standing monthly charge and a
 *     warm-up plan, so they must not move behind a Save button (#237, #225).
 *
 * What is left is what an operator plausibly got wrong at setup: the display
 * name, the timezone, and the sending domain.
 */
import type { Organization } from "@addressium/core";
import type { DnsRecord } from "./provisioning.js";
import { InvalidInputError } from "./ports.js";
import { normalizeSiteUrl } from "./site-url.js";
import type { Stores } from "./ports.js";

/** Fields this workflow may change. Everything else is provisioned or compliance. */
export interface OrgUpdate {
  name?: string;
  defaultTimezone?: string;
  /**
   * A domain to ADD as a sending identity, and make primary.
   *
   * Never a replacement list: see `applyOrgUpdate` for why nothing is removed.
   */
  addDomain?: string;
  /**
   * Where THIS org's subscriber pages are served — e.g.
   * `https://news.example.com` (#294).
   *
   * Orgs are siloed: each subscriber portal lives on a subdomain of the org's
   * OWN domain, so this is per-org rather than a deployment-wide setting. The
   * admin console itself is deployment-wide and is not configured here.
   */
  siteUrl?: string;
  /**
   * Confirms this org's distribution forwards `/api/*` to the API (#294).
   * Moves the one-click unsubscribe URL onto the org's own domain.
   */
  apiViaSite?: boolean;
}

export interface OrgUpdateResult {
  org: Organization;
  /** DNS the operator must publish for a newly-added domain. Empty otherwise. */
  dns: DnsRecord[];
  /** Field-level before/after, for the audit entry. */
  changed: Array<{ field: string; from: string; to: string }>;
}

/**
 * Which lists still send from a domain, by `fromAddress`.
 *
 * Because nothing is ever removed from `domains`, promoting a new primary
 * cannot break a send — the old identity keeps working. What it CAN do is
 * quietly leave every list still sending from the old domain, so an operator
 * who believes they have "changed the sending domain" has changed only which
 * one is displayed.
 *
 * So this is reported rather than enforced: the caller names the lists whose
 * `fromAddress` still points at the previous domain, and the operator decides.
 * Rewriting them automatically would change the From address on live
 * newsletters as a side effect of a settings save, which is worse.
 */
export async function listsSendingFrom(
  stores: Stores,
  orgId: string,
  domain: string,
): Promise<string[]> {
  const suffix = `@${domain.toLowerCase()}`;
  const lists = await stores.lists.list(orgId);
  return lists
    .filter((l) => l.fromAddress?.toLowerCase().endsWith(suffix))
    .map((l) => l.listId);
}

/** `Europe/London`, not `GMT+1` — IANA names are what the scheduler resolves. */
function isIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an update and produce the new record. Pure: the caller provisions
 * the SES identity and persists.
 *
 * NOTHING IS EVER REMOVED from `domains`. A domain in that list is a verified
 * SES identity, and in a shared account it may be carrying mail this deployment
 * knows nothing about — during the Pinpoint cutover the same identities serve
 * seven publications from the legacy system. Deleting one to "tidy up" a
 * settings change would stop that mail with no warning and no way back short of
 * re-verification. Correcting a domain therefore ADDS the new one and promotes
 * it to primary; retiring the old one is a separate, explicit act.
 */
export function planOrgUpdate(org: Organization, update: OrgUpdate): OrgUpdateResult {
  const changed: OrgUpdateResult["changed"] = [];
  const next: Organization = { ...org };

  if (update.name !== undefined) {
    const name = update.name.trim();
    if (!name) throw new InvalidInputError("name cannot be empty");
    if (name.length > 120) throw new InvalidInputError("name must be 120 characters or fewer");
    if (name !== org.name) {
      changed.push({ field: "name", from: org.name, to: name });
      next.name = name;
    }
  }

  if (update.defaultTimezone !== undefined) {
    const tz = update.defaultTimezone.trim();
    if (!isIanaZone(tz)) {
      // Named explicitly: a bad zone here silently moves every scheduled send.
      throw new InvalidInputError(
        `"${tz}" is not an IANA time zone (e.g. "America/New_York", "Europe/London")`,
      );
    }
    if (tz !== org.defaultTimezone) {
      changed.push({ field: "defaultTimezone", from: org.defaultTimezone, to: tz });
      next.defaultTimezone = tz;
    }
  }

  if (update.siteUrl !== undefined) {
    // Normalized to a bare origin, so two spellings of the same site compare
    // equal and no link is ever built from a URL carrying a path or a query.
    const siteUrl = normalizeSiteUrl(update.siteUrl);
    if (siteUrl !== org.siteUrl) {
      changed.push({ field: "siteUrl", from: org.siteUrl ?? "(none)", to: siteUrl });
      next.siteUrl = siteUrl;
    }
  }

  if (update.apiViaSite !== undefined && update.apiViaSite !== (org.apiViaSite ?? false)) {
    changed.push({
      field: "apiViaSite",
      from: String(org.apiViaSite ?? false),
      to: String(update.apiViaSite),
    });
    next.apiViaSite = update.apiViaSite;
  }

  if (update.addDomain !== undefined) {
    const domain = update.addDomain.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      throw new InvalidInputError(
        `"${domain}" is not a domain name — supply a hostname like "news.example.com", with no scheme or path`,
      );
    }
    const existing = (org.domains ?? []).map((d) => d.toLowerCase());
    if (existing[0] !== domain) {
      changed.push({ field: "primaryDomain", from: existing[0] ?? "(none)", to: domain });
      // Promoted to the front; every previous domain KEPT behind it.
      next.domains = [domain, ...existing.filter((d) => d !== domain)];
    }
  }

  return { org: next, dns: [], changed };
}
