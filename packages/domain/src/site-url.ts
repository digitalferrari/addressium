/**
 * Per-org subscriber-facing URLs (#294).
 *
 * Confirm, unsubscribe and preference links used to come from three stack-wide
 * Lambda environment variables, so every org on a deployment mailed links on
 * ONE hostname. A subscriber of publication A therefore received links on
 * publication B's domain, and a mismatch between the From domain and the
 * unsubscribe link reads as phishing to a person and to a spam filter alike.
 *
 * There is deliberately NO fallback to the shared hostname. A silent default is
 * precisely how `https://your-site.example/confirm` reached production and
 * broke double opt-in with no error anywhere: signup returned 200, the mail
 * sent, every link was dead. Refusing to send is the loud failure that was
 * missing.
 */
import type { Organization } from "@addressium/core";
import { InvalidInputError } from "./ports.js";

/** Thrown when an org tries to send without a configured `siteUrl`. */
export class SiteUrlNotConfiguredError extends InvalidInputError {
  constructor(orgId: string) {
    super(
      `Organization "${orgId}" has no site URL, so its confirmation, unsubscribe ` +
        `and preference links would point nowhere. Set it in Settings → Organization ` +
        `(e.g. https://news.example.com) before sending.`,
    );
    this.name = "SiteUrlNotConfiguredError";
  }
}

/**
 * Validate an operator-supplied site URL and normalize it to a bare origin.
 *
 * Accepts `https://news.example.com`, with or without a trailing slash, and
 * rejects anything carrying a path, query or credentials — those would produce
 * links like `https://host/blog/confirm?token=…`, which resolve to nothing.
 *
 * `http` is refused outright. These links carry a subscription token; sending
 * one over plaintext hands it to anyone on the path, and every mailbox provider
 * flags an insecure unsubscribe link.
 */
export function normalizeSiteUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new InvalidInputError("site URL is required");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidInputError(
      `"${trimmed}" is not a URL — supply an origin like https://news.example.com`,
    );
  }
  if (url.protocol !== "https:") {
    throw new InvalidInputError(
      `site URL must be https (got "${url.protocol}") — these links carry a subscription token`,
    );
  }
  if (url.username || url.password) throw new InvalidInputError("site URL must not contain credentials");
  if (url.search || url.hash) throw new InvalidInputError("site URL must not contain a query or fragment");
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new InvalidInputError(
      `site URL must be an origin with no path (got "${url.pathname}")`,
    );
  }
  // `URL.origin` drops the trailing slash and lowercases the host, which is
  // what makes two spellings of the same site compare equal downstream.
  return url.origin;
}

/**
 * The org's site origin, or throw. Every subscriber-link builder goes through
 * here so there is exactly one place the requirement is enforced.
 */
export function requireSiteUrl(
  org: Pick<Organization, "orgId" | "siteUrl"> | undefined,
): string {
  // `undefined` accepted on purpose: every caller reaches this from a store
  // lookup that can miss, and forcing each one to invent its own message for a
  // vanished org is how they end up disagreeing. A missing org has no site URL,
  // which is the same refusal.
  if (!org) throw new SiteUrlNotConfiguredError("(unknown)");
  const configured = org.siteUrl?.trim();
  if (!configured) throw new SiteUrlNotConfiguredError(org.orgId);
  return configured.replace(/\/+$/, "");
}

/** `https://news.example.com/confirm` — the double opt-in landing page. */
export const confirmUrl = (org: Pick<Organization, "orgId" | "siteUrl"> | undefined): string =>
  `${requireSiteUrl(org)}/confirm`;

/** `https://news.example.com/preferences` — the subscription-management page. */
export const preferencesUrl = (org: Pick<Organization, "orgId" | "siteUrl"> | undefined): string =>
  `${requireSiteUrl(org)}/preferences`;

/**
 * DNS and certificate steps for a newly-set site URL.
 *
 * addressium does NOT write DNS or attach the certificate: the zone may be
 * Cloudflare, Route 53 or anything else, and taking that over would mean
 * holding credentials for a zone that is not ours. The operator is shown what
 * to create instead.
 */
export function siteUrlSetupSteps(siteUrl: string, distributionDomain: string): string[] {
  const host = new URL(siteUrl).host;
  return [
    `Request an ACM certificate for ${host} in us-east-1 (CloudFront requires that region), and publish the CNAME it gives you for validation.`,
    `Add a CNAME (or ALIAS/ANAME at the zone apex) pointing ${host} at ${distributionDomain}.`,
    `Attach ${host} and the validated certificate to CloudFront distribution ${distributionDomain} as an alternate domain name.`,
    `Until all three are done, links on ${host} will not resolve — subscribers cannot confirm or unsubscribe.`,
  ];
}
