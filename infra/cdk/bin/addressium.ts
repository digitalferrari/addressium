#!/usr/bin/env node
/**
 * addressium CDK app entry point.
 *
 * Deploys the shared CONTROL PLANE (one per deployment). Per-org resources
 * (subscriber pool, KMS signing key, SES identity, config set, JWKS) are
 * provisioned at runtime by services/provisioning when an operator clicks
 * "Add organization" — see docs/ARCHITECTURE.md §4.11.
 */
import { App } from "aws-cdk-lib";
import { ControlPlaneStack } from "../lib/control-plane-stack.js";

const app = new App();
const stage = app.node.tryGetContext("stage") ?? "dev";

new ControlPlaneStack(app, `addressium-${stage}`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});

app.synth();
