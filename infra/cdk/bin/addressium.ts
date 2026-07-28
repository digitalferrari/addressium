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
  /**
   * An SNS topic YOU already own, for infrastructure alarms (#222, compendium
   * #22/#32). Alert routing is account-wide plumbing — addressium should not
   * take it over, and a topic it creates for you starts with no subscribers,
   * which means every alarm fires into a void.
   */
  opsAlertTopicArn?: string;
  /**
   * Convenience alternative: addressium creates a topic and subscribes this
   * address. Ignored when `opsAlertTopicArn` is set.
   */
  opsAlertEmail?: string;
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
      opsAlertTopicArn: cfg.opsAlertTopicArn,
      opsAlertEmail: cfg.opsAlertEmail,
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
  opsAlertTopicArn: config.opsAlertTopicArn,
  opsAlertEmail: config.opsAlertEmail,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
  },
});

app.synth();
