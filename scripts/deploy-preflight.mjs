#!/usr/bin/env node
/**
 * Fail a full `npm run deploy` BEFORE it ships anything (#294).
 *
 * `deploy` is `deploy:infra && deploy:spas`. Every input the SPA publish needs
 * that is NOT derived from stack outputs has to be validated here, because
 * `deploy:spas` runs after CloudFormation: without this, a missing variable
 * moves the API forward and then fails, leaving the bundles stale — exactly the
 * split-deploy state #294 exists to remove.
 *
 * Only `deploy` runs this. `deploy:infra` on its own is a legitimate
 * infrastructure-only deploy and must not require SPA configuration.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

/**
 * `confirmUrlBase` decides where subscriber confirmation links point. The stack
 * falls back to `https://your-site.example/confirm` — a domain nobody owns — and
 * NOTHING fails when it does: signup returns 200, the mail sends, and every
 * confirmation link is dead. Double opt-in is broken with no error anywhere.
 *
 * It used to be readable only from CDK context, so a deploy that omitted
 * `-c confirmUrlBase=...` silently reset the live Lambdas to the placeholder.
 * That happened on 2026-09-23. It now lives in `addressium.config.json`, and
 * this refuses to deploy without a real value rather than trusting the operator
 * to remember a flag on every single deploy.
 */
const PUBLIC_URL_SETTINGS = [
  { key: "confirmUrlBase", placeholder: "https://your-site.example/confirm", suffix: "/confirm" },
  { key: "preferencesUrlBase", placeholder: "https://your-site.example/preferences", suffix: "/preferences" },
];
const configPath = resolve(import.meta.dirname, "../infra/cdk/addressium.config.json");
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
  fail(`deploy preflight: cannot read infra/cdk/addressium.config.json (${err.message})`);
}

for (const { key, placeholder, suffix } of PUBLIC_URL_SETTINGS) {
  const value = config[key]?.trim();
  if (!value || value === placeholder) {
    fail(
      `deploy preflight: ${key} is ${value ? "the placeholder" : "unset"} in infra/cdk/addressium.config.json.\n` +
        "The link addressium mails subscribers would point at a domain nobody owns,\n" +
        "and nothing would report an error — the request succeeds and the mail sends.\n\n" +
        `Set it to the PublicSiteUrl stack output plus ${suffix}, e.g.\n` +
        `  "${key}": "https://d1234abcd.cloudfront.net${suffix}"`,
    );
  }
}

const required = ["ADDRESSIUM_PUBLIC_ORG_ID"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  fail(
    `deploy preflight: missing ${missing.join(", ")}.\n` +
      "`npm run deploy` publishes the SPAs after the stack and needs this up front,\n" +
      "so it fails here rather than half-way through a deploy.\n\n" +
      `  ${missing.map((n) => `${n}=<value>`).join(" ")} npm run deploy\n\n` +
      "For infrastructure only, with no SPA publish: npm run deploy:infra",
  );
}
