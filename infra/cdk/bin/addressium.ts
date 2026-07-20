#!/usr/bin/env node
/**
 * addressium CDK app entry point.
 *
 * Deploys the shared CONTROL PLANE (one per deployment), which INCLUDES the
 * admin Cognito user pool and the seeded first admin user(s) — so someone can
 * actually sign in without any manual pool setup. Per-org resources (subscriber
 * pool, KMS signing key, SES identity, config set, JWKS) are provisioned at
 * runtime by services/provisioning on "Add organization" (§4.11).
 *
 * Bootstrap config comes from ./addressium.config.json (see the .example file).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { ControlPlaneStack } from "../lib/control-plane-stack.js";

interface BootstrapConfig {
  stage: string;
  region: string;
  adminEmails: string[];
  adminHostedUiDomainPrefix: string;
}

function loadConfig(): BootstrapConfig {
  const path = resolve(process.cwd(), "addressium.config.json");
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as Partial<BootstrapConfig>;
    if (!cfg.adminEmails?.length) {
      throw new Error("addressium.config.json must list at least one adminEmails entry.");
    }
    return {
      stage: cfg.stage ?? "dev",
      region: cfg.region ?? "us-east-1",
      adminEmails: cfg.adminEmails,
      adminHostedUiDomainPrefix: cfg.adminHostedUiDomainPrefix ?? "addressium-admin",
    };
  } catch (err) {
    throw new Error(
      `Could not load addressium.config.json — copy addressium.config.example.json and set your admin email. (${(err as Error).message})`,
    );
  }
}

const config = loadConfig();
const app = new App();

new ControlPlaneStack(app, `addressium-${config.stage}`, {
  stage: config.stage,
  adminEmails: config.adminEmails,
  adminHostedUiDomainPrefix: config.adminHostedUiDomainPrefix,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
  },
});

app.synth();
