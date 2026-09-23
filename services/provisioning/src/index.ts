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
import { dnsRecords, listsSendingFrom, planOrgUpdate, provisionOrganization, recordAudit, SystemClock } from "@addressium/domain";
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
  pathParameters?: { org?: string } | null;
}

export async function handler(event: ProvisionEvent) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const raw = event.body ? JSON.parse(event.body) : event;

  // Rotation is org-scoped. It lives in this Lambda because the provisioning
  // role already owns KMS key creation and the organization record write, but
  // unlike org creation it must never use the global `*` grant.
  if (raw && typeof raw === "object" && (raw as { action?: unknown }).action === "rotateMagicLinkKey") {
    const orgId = event.pathParameters?.org ?? (raw as { orgId?: unknown }).orgId;
    const parsedOrg = schemas.idSchema.safeParse(orgId);
    if (!parsedOrg.success) return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "valid org is required" }) };
    try {
      authorize(grantFromClaims(claims), "identity:manage", parsedOrg.data);
    } catch {
      return { statusCode: 403, headers: {}, body: JSON.stringify({ error: "forbidden" }) };
    }
    const org = await stores().organizations.get(parsedOrg.data);
    if (!org) return { statusCode: 404, headers: {}, body: JSON.stringify({ error: "organization not found" }) };
    if (!org.magicLink) return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "magic links are not enabled" }) };
    if (!providers.rotateSigningKey) {
      console.error("magic-link rotation provider is unavailable", { orgId: parsedOrg.data });
      return { statusCode: 500, headers: {}, body: JSON.stringify({ error: "key rotation is unavailable" }) };
    }
    const key = await providers.rotateSigningKey(parsedOrg.data);
    const previous = org.magicLink.keys?.length
      ? org.magicLink.keys
      : [{ kmsKeyArn: org.magicLink.kmsKeyArn, kid: org.magicLink.kid }];
    const rotatedAt = clock.now().toISOString();
    await stores().organizations.put({
      ...org,
      magicLink: {
        ...org.magicLink,
        kmsKeyArn: key.kmsKeyArn,
        kid: key.kid,
        keys: [{ kmsKeyArn: key.kmsKeyArn, kid: key.kid }, ...previous.filter((p) => p.kid !== key.kid)],
        rotatedAt,
      },
    });
    try {
      await recordAudit(auditLog(), clock, {
        orgId: parsedOrg.data,
        memberSub: claims.sub ?? "unknown",
        action: "identity.magic_link_key.rotate",
        target: key.kid,
      });
    } catch (e) {
      console.error("audit: append failed", { action: "identity.magic_link_key.rotate", error: (e as Error).message });
    }
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: parsedOrg.data, kid: key.kid, keyCount: previous.length + 1, rotatedAt }),
    };
  }

  /**
   * Correct an organization's settings, including its sending domain (#294).
   *
   * Lives in THIS Lambda, not the API, because a domain change needs
   * `ses:CreateEmailIdentity` — a grant `services/adapters-aws/ses-identity.ts`
   * deliberately keeps off the internet-facing router. Reusing the provisioning
   * role also means this shipped with no new IAM at all.
   *
   * Org-scoped (`identity:manage` on THIS org), unlike org creation below which
   * is cross-org and needs the `*` grant.
   */
  if (raw && typeof raw === "object" && (raw as { action?: unknown }).action === "updateOrganization") {
    const orgId = event.pathParameters?.org ?? (raw as { orgId?: unknown }).orgId;
    const parsedOrg = schemas.idSchema.safeParse(orgId);
    if (!parsedOrg.success) return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "valid org is required" }) };
    try {
      authorize(grantFromClaims(claims), "identity:manage", parsedOrg.data);
    } catch {
      return { statusCode: 403, headers: {}, body: JSON.stringify({ error: "forbidden" }) };
    }

    const org = await stores().organizations.get(parsedOrg.data);
    if (!org) return { statusCode: 404, headers: {}, body: JSON.stringify({ error: "unknown org" }) };

    const input = raw as { name?: string; defaultTimezone?: string; addDomain?: string };
    let planned;
    try {
      planned = planOrgUpdate(org, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.defaultTimezone !== undefined ? { defaultTimezone: input.defaultTimezone } : {}),
        ...(input.addDomain !== undefined ? { addDomain: input.addDomain } : {}),
      });
    } catch (e) {
      return { statusCode: 400, headers: {}, body: JSON.stringify({ error: (e as Error).message }) };
    }
    if (planned.changed.length === 0) {
      return { statusCode: 200, headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: parsedOrg.data, changed: [], dns: [] }) };
    }

    // A new primary domain needs a verified SES identity before anything sends
    // from it. `ensureSesDomainIdentity` is idempotent and does a get-first, so
    // a domain the account already holds — every one of them, during the
    // Pinpoint cutover — is REUSED rather than recreated, and its existing DKIM
    // is left alone.
    let dns = planned.dns;
    const domainChange = planned.changed.find((c) => c.field === "primaryDomain");
    if (domainChange) {
      const identity = await providers.ensureSesDomainIdentity(
        parsedOrg.data, domainChange.to, org.dedicatedIpPoolName,
      );
      dns = dnsRecords(domainChange.to, identity.dkimTokens, {
        ...(org.dmarcPolicy ? { dmarcPolicy: org.dmarcPolicy } : {}),
        ...(identity.mailFromDomain ? { mailFromDomain: identity.mailFromDomain } : {}),
        ...(identity.mailFromMxHost ? { mailFromMxHost: identity.mailFromMxHost } : {}),
      });
    }

    // Re-read and merge only the changed fields. Settings, customer-sync and
    // magic-link rotation all write this record too, and putting back a whole
    // object read before the SES round-trip above would revert whichever of
    // them landed in between — including a key rotation.
    const current = await stores().organizations.get(parsedOrg.data);
    if (!current) return { statusCode: 404, headers: {}, body: JSON.stringify({ error: "unknown org" }) };
    const merged = { ...current };
    for (const c of planned.changed) {
      if (c.field === "name") merged.name = planned.org.name;
      if (c.field === "defaultTimezone") merged.defaultTimezone = planned.org.defaultTimezone;
      if (c.field === "primaryDomain") merged.domains = planned.org.domains;
    }
    await stores().organizations.put(merged);

    try {
      await recordAudit(auditLog(), clock, {
        orgId: parsedOrg.data,
        memberSub: claims.sub ?? "unknown",
        action: "organization.update",
        // Before AND after, per field: "who changed the sending domain, from
        // what" is the question this entry exists to answer.
        target: planned.changed.map((c) => `${c.field}: ${c.from} -> ${c.to}`).join("; "),
      });
    } catch (e) {
      console.error("audit: append failed", { action: "organization.update", error: (e as Error).message });
    }

    // Nothing was removed, so no send can break — but every list still sending
    // from the OLD domain is now sending from a domain that is no longer
    // primary, which an operator who just "changed the sending domain" will not
    // expect. Named, not rewritten: silently editing the From address on live
    // newsletters would be the worse surprise.
    const staleLists = domainChange
      ? await listsSendingFrom(stores(), parsedOrg.data, domainChange.from)
      : [];

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgId: parsedOrg.data,
        changed: planned.changed,
        dns,
        ...(staleLists.length > 0
          ? {
              warning:
                `${staleLists.length} list(s) still send from ${domainChange!.from}: ` +
                `${staleLists.join(", ")}. The old domain remains a verified sending ` +
                `identity, so they keep working — update each list's from-address ` +
                `when you want them on ${domainChange!.to}.`,
              listsOnPreviousDomain: staleLists,
            }
          : {}),
      }),
    };
  }

  // Adding an org is a cross-org action → requires the identity:manage capability.
  try {
    authorize(grantFromClaims(claims), "identity:manage", "*");
  } catch {
    return { statusCode: 403, headers: {}, body: JSON.stringify({ error: "forbidden" }) };
  }

  const parsed = schemas.createOrgSchema.safeParse(raw);
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
