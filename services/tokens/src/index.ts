/**
 * addressium service: tokens — publishes each org's JWKS (§4.9, §12).
 *
 * GET /orgs/{org}/.well-known/jwks.json → the org's magic-link public key as a
 * JWK set (the route this handler is wired to in the CDK stack), so the
 * operator's main website can verify magic-link tokens offline. Minting itself
 * happens in the sender (per-org KMS key); this only publishes the public half.
 */
import { DynamoStores, KmsJwksProvider } from "@addressium/adapters-aws";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));
const provider = new KmsJwksProvider();

export interface JwksEvent {
  pathParameters?: { org?: string } | null;
  orgId?: string;
}

export async function handler(event: JwksEvent) {
  const orgId = event.pathParameters?.org ?? event.orgId;
  if (!orgId) return { statusCode: 400, headers: {}, body: JSON.stringify({ error: "org required" }) };
  const org = await stores().organizations.get(orgId);
  if (!org) return { statusCode: 404, headers: {}, body: JSON.stringify({ error: "unknown org" }) };

  // An org with magic links off has no signing key, so there is no key to
  // publish. Serve an empty (but valid) JWKS rather than 404: a publisher site
  // polling the endpoint gets a well-formed document it can cache, and any
  // token presented against it fails verification — which is the correct
  // outcome, since this org never mints one.
  if (!org.magicLink) {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
      body: JSON.stringify({ keys: [] }),
    };
  }

  const keys = org.magicLink.keys?.length
    ? org.magicLink.keys
    : [{ kmsKeyArn: org.magicLink.kmsKeyArn, kid: org.magicLink.kid }];
  const jwks = await provider.jwks(keys);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    body: JSON.stringify(jwks),
  };
}
