#!/usr/bin/env node
/**
 * Build and publish all SPAs after a successful control-plane deployment.
 *
 * This is intentionally a CI-facing command: it reads the exact stack outputs
 * rather than accepting hand-copied buckets/endpoints, then invalidates only
 * the distributions it just populated. The public and subscriber shells share
 * one bucket but own distinct prefixes, so their deletes are scoped.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const configPath = resolve(root, "infra/cdk/addressium.config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const required = (name, value) => {
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const run = (command, args, env = {}) =>
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
const aws = (query) =>
  execFileSync(
    "aws",
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      process.env.ADDRESSIUM_STACK ?? `addressium-${required("config.stage", config.stage)}`,
      "--query",
      `Stacks[0].Outputs[?OutputKey=='${query}'].OutputValue | [0]`,
      "--output",
      "text",
      "--region",
      config.region ?? "us-east-1",
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();

const api = required("HttpApiUrl stack output", aws("HttpApiUrl"));
const adminBucket = required("AdminSiteBucket stack output", aws("AdminSiteBucket"));
const publicBucket = required("PublicSiteBucket stack output", aws("PublicSiteBucket"));
const adminDistribution = required("AdminDistributionId stack output", aws("AdminDistributionId"));
const publicDistribution = required("PublicDistributionId stack output", aws("PublicDistributionId"));
const adminHost = required("AdminSiteUrl stack output", aws("AdminSiteUrl"));
const pool = required("AdminPoolId stack output", aws("AdminPoolId"));
const client = required("AdminClientId stack output", aws("AdminClientId"));
const publicOrg = required("ADDRESSIUM_PUBLIC_ORG_ID", process.env.ADDRESSIUM_PUBLIC_ORG_ID);
const region = config.region ?? "us-east-1";
const hostedUi = `${required("config.adminHostedUiDomainPrefix", config.adminHostedUiDomainPrefix)}-${config.stage}.auth.${region}.amazoncognito.com`;

run("npm", ["run", "build", "--workspace", "@addressium/admin-web"], {
  VITE_API_BASE: api,
  VITE_COGNITO_POOL_ID: pool,
  VITE_COGNITO_CLIENT_ID: client,
  VITE_COGNITO_DOMAIN: hostedUi,
  VITE_REDIRECT_URI: `https://${adminHost}/`,
});
run("npm", ["run", "build", "--workspace", "@addressium/subscriber-web"], {
  VITE_API_BASE: api,
  VITE_ORG_ID: publicOrg,
});
run("npm", ["run", "build", "--workspace", "@addressium/public-web"], {
  VITE_API_BASE: api,
  VITE_ORG_ID: publicOrg,
});

run("aws", ["s3", "sync", "apps/admin-web/dist", `s3://${adminBucket}`, "--delete", "--region", region]);
run("aws", ["s3", "sync", "apps/subscriber-web/dist", `s3://${publicBucket}`, "--delete", "--exclude", "signup/*", "--region", region]);
run("aws", ["s3", "sync", "apps/public-web/dist", `s3://${publicBucket}/signup`, "--delete", "--region", region]);
run("aws", ["cloudfront", "create-invalidation", "--distribution-id", adminDistribution, "--paths", "/*"]);
run("aws", ["cloudfront", "create-invalidation", "--distribution-id", publicDistribution, "--paths", "/*"]);
