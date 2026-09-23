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
const required = ["ADDRESSIUM_PUBLIC_ORG_ID"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `deploy preflight: missing ${missing.join(", ")}.\n` +
      "`npm run deploy` publishes the SPAs after the stack and needs this up front,\n" +
      "so it fails here rather than half-way through a deploy.\n\n" +
      `  ${missing.map((n) => `${n}=<value>`).join(" ")} npm run deploy\n\n` +
      "For infrastructure only, with no SPA publish: npm run deploy:infra",
  );
  process.exit(1);
}
