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
 * `confirmUrlBase` / `preferencesUrlBase` decide where the links addressium
 * mails subscribers point.
 *
 * Leaving them UNSET is fine: the stack derives both from the public
 * distribution it creates. What is never fine is the literal
 * `your-site.example` placeholder — a domain nobody owns — which is what they
 * used to default to. Nothing failed when they did: signup returned 200, the
 * preference-centre request returned 200, both sent mail, and every link in it
 * was dead.
 *
 * The placeholder no longer appears in the stack, so this guards against it
 * being pasted back into the config by hand, or copied from an old runbook.
 */
const PLACEHOLDER = "your-site.example";
const configPath = resolve(import.meta.dirname, "../infra/cdk/addressium.config.json");
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
  fail(`deploy preflight: cannot read infra/cdk/addressium.config.json (${err.message})`);
}

for (const key of ["confirmUrlBase", "preferencesUrlBase"]) {
  const value = config[key]?.trim();
  // Absent is valid — the stack derives it. Only the dead placeholder is not.
  if (value && value.includes(PLACEHOLDER)) {
    fail(
      `deploy preflight: ${key} is set to the ${PLACEHOLDER} placeholder in\n` +
        "infra/cdk/addressium.config.json. That is a domain nobody owns, so every\n" +
        "link addressium mails subscribers would be dead — and nothing would report\n" +
        "it, because the request succeeds and the mail sends.\n\n" +
        "Remove the key to derive it from the public distribution, or set a real URL.",
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
