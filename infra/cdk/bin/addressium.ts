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
import { App, PERMISSIONS_BOUNDARY_CONTEXT_KEY, Tags } from "aws-cdk-lib";
import { ControlPlaneStack, parseStage } from "../lib/control-plane-stack.js";

interface BootstrapConfig {
  /** One of `dev` | `staging` | `prod`. Validated — see `loadConfig` (#190). */
  stage: string;
  region: string;
  adminEmails: string[];
  adminHostedUiDomainPrefix: string;
  /** Optional Cloudflare/external-DNS hostname for the operator console. */
  adminCustomDomain?: CustomDomainConfig;
  /** Optional Cloudflare/external-DNS hostname for subscriber/public pages. */
  publicCustomDomain?: CustomDomainConfig;
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
  /**
   * Address Cognito sends operator invites and password resets FROM, e.g.
   * "addressium@mail.example.com". Its domain (or the address itself) must be a
   * VERIFIED SES identity in this account before you deploy — Cognito checks at
   * stack-update time and fails the deploy otherwise.
   *
   * Leave unset and Cognito uses its own sender. That default is capped at 50
   * emails/day account-wide, sends from a shared amazonses.com address with poor
   * reputation, and reports NOTHING about delivery — no bounces, no metrics, no
   * logs. An invite that never arrives is indistinguishable from one that was
   * never sent, which is a bad property for the emails that gate console access.
   */
  adminFromEmail?: string;
  /**
   * Where subscriber confirmation links point, e.g.
   * "https://d3n0nygr388rl7.cloudfront.net/confirm".
   *
   * REQUIRED IN PRACTICE. The stack falls back to `https://your-site.example/
   * confirm`, which is a placeholder nobody owns: signup still succeeds and the
   * mail still sends, so double opt-in breaks with no error anywhere — every
   * confirmation link simply goes nowhere.
   *
   * It lives HERE, in the gitignored config, because the alternative was
   * passing `-c confirmUrlBase=...` on every single deploy. That is a step you
   * only have to forget once, and forgetting it silently reverts the live
   * Lambdas to the placeholder. Do NOT move it to the git-TRACKED `cdk.json`:
   * a real hostname there ships to everyone who clones this MIT repo and routes
   * OTHER operators' confirmation tokens to a distribution we control, which is
   * worse than the placeholder — the placeholder at least fails dead.
   */
  confirmUrlBase?: string;
  /**
   * Where preference-centre links point, e.g.
   * "https://d3n0nygr388rl7.cloudfront.net/preferences".
   *
   * Exactly the same failure as `confirmUrlBase`, on the surface subscribers
   * use to MANAGE or LEAVE: the fallback is `https://your-site.example/
   * preferences`, the "email me a link" request returns 200, the mail sends,
   * and the link is dead. Set it alongside confirmUrlBase.
   */
  preferencesUrlBase?: string;
  /** A REGIONAL WebACL you own, associated with the API stage (#225). */
  apiWebAclArn?: string;
  /**
   * This stack's share of the account SES send rate, messages/second.
   * REQUIRED — there is deliberately no default; see the stack for why.
   * Read the account quota with:
   *   aws sesv2 get-account --query 'SendQuota.MaxSendRate'
   */
  sesMaxSendRate?: number;
  /** Concurrent sender invocations. Optional; defaults to 5 in the stack. */
  senderMaxConcurrency?: number;
  /** A CLOUDFRONT-scope WebACL (us-east-1) for both SPA distributions. */
  cloudfrontWebAclArn?: string;
}

interface CustomDomainConfig {
  domainName: string;
}

function validateCustomDomain(value: CustomDomainConfig | undefined, name: string): CustomDomainConfig | undefined {
  if (!value) return undefined;
  if (!value.domainName) {
    throw new Error(`${name} requires domainName.`);
  }
  if (!/^[a-z0-9.-]+$/i.test(value.domainName) || value.domainName.includes("..")) {
    throw new Error(`${name}.domainName must be a DNS hostname, without https:// or a path.`);
  }
  return value;
}

function loadConfig(): BootstrapConfig {
  const path = resolve(process.cwd(), "addressium.config.json");
  // Only the READ and the PARSE are wrapped. A validation failure below is a
  // different problem with a different fix, and burying "invalid stage" under
  // "copy the example file and set your admin email" sends the operator to the
  // wrong line (#190).
  let cfg: Partial<BootstrapConfig>;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8")) as Partial<BootstrapConfig>;
  } catch (err) {
    throw new Error(
      `Could not load addressium.config.json — copy addressium.config.example.json and set your admin email. (${(err as Error).message})`,
    );
  }

  if (!cfg.adminEmails?.length) {
    throw new Error("addressium.config.json must list at least one adminEmails entry.");
  }
  // Validated HERE as well as in the stack, so the message names the file the
  // operator edits. A mistyped stage — "production", "Prod" — compared unequal
  // to "prod" and silently produced a stack configured as a scratch environment
  // while holding production data.
  const stage = parseStage(cfg.stage ?? "dev");

  return {
    stage,
    region: cfg.region ?? "us-east-1",
    adminEmails: cfg.adminEmails,
    adminHostedUiDomainPrefix: cfg.adminHostedUiDomainPrefix ?? "addressium-admin",
    adminCustomDomain: validateCustomDomain(cfg.adminCustomDomain, "adminCustomDomain"),
    publicCustomDomain: validateCustomDomain(cfg.publicCustomDomain, "publicCustomDomain"),
    opsAlertTopicArn: cfg.opsAlertTopicArn,
    opsAlertEmail: cfg.opsAlertEmail,
    adminFromEmail: cfg.adminFromEmail,
    confirmUrlBase: cfg.confirmUrlBase,
    preferencesUrlBase: cfg.preferencesUrlBase,
    apiWebAclArn: cfg.apiWebAclArn,
    sesMaxSendRate: cfg.sesMaxSendRate,
    senderMaxConcurrency: cfg.senderMaxConcurrency,
    cloudfrontWebAclArn: cfg.cloudfrontWebAclArn,
  };
}

const config = loadConfig();

// Every role this app creates is capped by the same boundary that caps the
// deployer. This is not belt-and-braces: infra/bootstrap grants iam:CreateRole
// ONLY when the new role carries this boundary, so without this line the 31
// roles CDK synthesizes are created uncapped — or, once the condition is in
// place, not created at all and the deploy fails at the first role.
//
// Set as CONTEXT rather than per-role because the Aspect behind this key
// matches on the CloudFormation type string, so it also reaches roles built by
// the low-level CustomResourceProvider path — the S3 auto-delete provider
// role, which is NOT an iam.Role and which a per-construct approach misses.
//
// Must be passed to the App constructor: the Stack constructor reads this key
// eagerly, and setContext() after a child exists throws. The name is derived
// from the stage because the boundary is named per-stage (#190 — a stage typo
// must not silently attach the dev boundary to a prod stack).
const app = new App({
  context: {
    [PERMISSIONS_BOUNDARY_CONTEXT_KEY]: { name: `addressium-${config.stage}-boundary` },
    // Send-rate settings reach the stack as CONTEXT, not props, because that is
    // what `-c sesMaxSendRate=...` on the command line sets — so an operator can
    // override the file for one deploy without editing it. Undefined here leaves
    // the key absent, and the stack throws with the command that reveals the real
    // number rather than deploying a silently throttled sender.
    ...(config.sesMaxSendRate !== undefined
      ? { sesMaxSendRate: String(config.sesMaxSendRate) }
      : {}),
    ...(config.senderMaxConcurrency !== undefined
      ? { senderMaxConcurrency: String(config.senderMaxConcurrency) }
      : {}),
    // Same reasoning, and the same read path: the stack reads
    // `confirmUrlBase` from context, so setting it here makes the config file
    // the source of truth while `-c confirmUrlBase=...` still overrides it for
    // a one-off deploy. Before this, context was the ONLY source, so a deploy
    // that omitted the flag reset live subscriber confirmation to a dead
    // placeholder domain — which is exactly what happened on 2026-09-23.
    ...(config.confirmUrlBase !== undefined
      ? { confirmUrlBase: config.confirmUrlBase }
      : {}),
    ...(config.preferencesUrlBase !== undefined
      ? { preferencesUrlBase: config.preferencesUrlBase }
      : {}),
  },
});

// Tag everything. addressium is designed to be self-hosted into an account the
// operator already uses for other things, so "which of these 300+ resources are
// yours?" has to have an answer that does not depend on reading the stack.
// These are also what makes Cost Explorer able to say what addressium costs as
// opposed to everything else in the account — but they must be activated as
// cost allocation tags in Billing first; tagging alone does not do it.
//
// Applied at App scope so it reaches every stack. Tags propagate to resources
// that support them; the handful that do not (and CloudFront distributions in
// particular) simply ignore this.
Tags.of(app).add("Application", "addressium");
Tags.of(app).add("Stage", config.stage);
Tags.of(app).add("ManagedBy", "cdk");

new ControlPlaneStack(app, `addressium-${config.stage}`, {
  stage: config.stage,
  adminEmails: config.adminEmails,
  adminHostedUiDomainPrefix: config.adminHostedUiDomainPrefix,
  adminCustomDomain: config.adminCustomDomain,
  publicCustomDomain: config.publicCustomDomain,
  opsAlertTopicArn: config.opsAlertTopicArn,
  opsAlertEmail: config.opsAlertEmail,
  adminFromEmail: config.adminFromEmail,
  apiWebAclArn: config.apiWebAclArn,
  cloudfrontWebAclArn: config.cloudfrontWebAclArn,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
  },
});

app.synth();
