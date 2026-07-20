/**
 * addressium service: provisioning — "Add organization" (§4.11, #14).
 *
 * Validates the request, then creates/links the subscriber Cognito pool, the
 * per-org KMS signing key, and the SES domain identity + config set, writes the
 * Organization record (with defaultTimezone + magic-link config), and returns
 * the DNS records the operator must publish for DKIM/SPF/DMARC. The org's JWKS
 * is served by the tokens service once the key exists. Idempotent on org id.
 */
import { schemas } from "@addressium/core";
import { AwsProvisioningProviders, DynamoStores } from "@addressium/adapters-aws";
import { provisionOrganization } from "@addressium/domain";
import { authorize, grantFromClaims } from "@addressium/rbac";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));
const providers = new AwsProvisioningProviders();

export interface ProvisionEvent {
  body?: string;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, string> } } };
  orgId?: string;
}

export async function handler(event: ProvisionEvent) {
  // Adding an org is a cross-org action → requires the identity:manage capability.
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  try {
    authorize(grantFromClaims(claims), "identity:manage", "*");
  } catch {
    return { statusCode: 403, headers: {}, body: JSON.stringify({ error: "forbidden" }) };
  }

  const parsed = schemas.createOrgSchema.safeParse(event.body ? JSON.parse(event.body) : event);
  if (!parsed.success) {
    return { statusCode: 400, headers: {}, body: JSON.stringify({ error: parsed.error.issues }) };
  }

  const result = await provisionOrganization(stores(), providers, parsed.data, { orgId: event.orgId });
  return {
    statusCode: result.alreadyExisted ? 200 : 201,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orgId: result.org.orgId,
      setupComplete: result.org.setupComplete,
      dns: result.dns,
      alreadyExisted: result.alreadyExisted,
    }),
  };
}
