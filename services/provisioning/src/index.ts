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
import { AwsProvisioningProviders, DynamoStores, S3AuditLog } from "@addressium/adapters-aws";
import { provisionOrganization, recordAudit, SystemClock } from "@addressium/domain";
import { authorize, grantFromClaims } from "@addressium/rbac";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));
let _audit: S3AuditLog | undefined;
const auditLog = () => (_audit ??= new S3AuditLog(env("AUDIT_BUCKET")));
const clock = new SystemClock();
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

  // `event.orgId` overrides the slug derived from the name, and it came off the
  // RAW event — so `slugifyOrgId` was bypassed entirely and an unchecked string
  // went on to be interpolated into S3 keys, a Secrets Manager name, an
  // OpenSearch index, a KMS alias, and the magic-link `issuer`. `createOrgSchema`
  // has no `orgId` field to catch it, so it is validated explicitly here rather
  // than by being "parsed" through a schema that never looks at it (#196).
  let orgId: string | undefined;
  if (event.orgId !== undefined) {
    const id = schemas.idSchema.safeParse(event.orgId);
    if (!id.success) {
      return {
        statusCode: 400,
        headers: {},
        body: JSON.stringify({ error: id.error.issues.map((i) => ({ ...i, path: ["orgId"] })) }),
      };
    }
    orgId = id.data;
  }

  const result = await provisionOrganization(stores(), providers, parsed.data, { orgId });
  // Org provisioning is one of §4.19's audited privileged actions. Cross-org,
  // so the entry is GLOBAL-scoped (orgId null) with the new org as the target;
  // an idempotent re-run that created nothing is not an event worth logging.
  // Audit must never take provisioning down with it — log and continue.
  if (!result.alreadyExisted) {
    try {
      await recordAudit(auditLog(), clock, {
        orgId: null,
        memberSub: claims.sub ?? "unknown",
        action: "orgs.create",
        target: result.org.orgId,
      });
    } catch (e) {
      console.error("audit: append failed", { action: "orgs.create", error: (e as Error).message });
    }
  }
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
