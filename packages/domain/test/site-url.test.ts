/**
 * Per-org subscriber URLs (#294).
 *
 * Orgs are siloed: addressium is the management and sending plane, but each
 * org's subscriber portal lives on a subdomain of that org's OWN domain. A
 * confirm or unsubscribe link on a shared hostname is a mismatch between the
 * From domain and the link, which reads as phishing to a person and to a spam
 * filter alike.
 *
 * There is deliberately NO fallback. A silent default is exactly how
 * `https://your-site.example/confirm` reached production and broke double
 * opt-in with no error anywhere — signup returned 200, the mail sent, and every
 * link was dead. Refusing to send is the loud failure that was missing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSiteUrl,
  requireSiteUrl,
  confirmUrl,
  preferencesUrl,
  siteUrlSetupSteps,
  SiteUrlNotConfiguredError,
} from "@addressium/domain";

const org = (siteUrl?: string) => ({ orgId: "acme", ...(siteUrl ? { siteUrl } : {}) });

test("an org with no site URL cannot build a subscriber link", () => {
  // The whole point: this THROWS rather than falling back to a shared host.
  assert.throws(() => confirmUrl(org()), SiteUrlNotConfiguredError);
  assert.throws(() => preferencesUrl(org()), SiteUrlNotConfiguredError);
  assert.throws(() => requireSiteUrl(org()), /has no site URL/);
  // And the message names the org and where to fix it, because this surfaces
  // as a failed send someone has to diagnose.
  assert.throws(() => requireSiteUrl(org()), /Settings → Organization/);
});

test("a vanished org is the same refusal, not a crash", () => {
  // Every caller reaches this from a store lookup that can miss.
  assert.throws(() => requireSiteUrl(undefined), SiteUrlNotConfiguredError);
});

test("links are built on the ORG's own host", () => {
  const acme = org("https://news.acme.example");
  assert.equal(confirmUrl(acme), "https://news.acme.example/confirm");
  assert.equal(preferencesUrl(acme), "https://news.acme.example/preferences");
  // A second org gets ITS OWN host — the siloing this exists for.
  const other = { orgId: "beta", siteUrl: "https://mail.beta.example" };
  assert.equal(confirmUrl(other), "https://mail.beta.example/confirm");
});

test("a trailing slash never produces a double slash", () => {
  assert.equal(confirmUrl(org("https://news.acme.example/")), "https://news.acme.example/confirm");
});

test("normalize accepts what an operator plausibly types", () => {
  for (const [input, expected] of [
    ["https://news.acme.example", "https://news.acme.example"],
    ["https://news.acme.example/", "https://news.acme.example"],
    ["  https://news.acme.example  ", "https://news.acme.example"],
    ["https://NEWS.Acme.Example", "https://news.acme.example"],
  ] as [string, string][]) {
    assert.equal(normalizeSiteUrl(input), expected, input);
  }
});

test("normalize refuses what would produce a dead link", () => {
  // http is refused outright: these URLs carry a subscription token, and every
  // mailbox provider flags an insecure unsubscribe link.
  assert.throws(() => normalizeSiteUrl("http://news.acme.example"), /must be https/);
  // A path would build `https://host/blog/confirm?token=…`, which resolves to
  // nothing — and would do so silently.
  assert.throws(() => normalizeSiteUrl("https://acme.example/blog"), /no path/);
  assert.throws(() => normalizeSiteUrl("https://acme.example?x=1"), /query or fragment/);
  assert.throws(() => normalizeSiteUrl("https://user:pw@acme.example"), /credentials/);
  assert.throws(() => normalizeSiteUrl("news.acme.example"), /is not a URL/);
  assert.throws(() => normalizeSiteUrl(""), /required/);
});

test("setup steps name the host, the target and the consequence", () => {
  const steps = siteUrlSetupSteps("https://news.acme.example", "d123.cloudfront.net");
  const all = steps.join(" ");
  assert.ok(all.includes("news.acme.example"), "names the operator's host");
  assert.ok(all.includes("d123.cloudfront.net"), "names the CNAME target");
  assert.ok(/us-east-1/.test(all), "CloudFront certs must be requested in us-east-1");
  // The consequence, spelled out: an operator who stops after step 1 has a
  // domain that silently cannot confirm or unsubscribe anyone.
  assert.ok(/cannot confirm or unsubscribe/.test(all));
});
