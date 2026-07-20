/**
 * addressium service: tokens — publishes each org's JWKS (§4.9, §12).
 *
 * GET /{org}/jwks.json → the org's magic-link public key as a JWK set, so the
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

  const jwks = await provider.jwks(org.magicLink.kmsKeyArn, org.magicLink.kid);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    body: JSON.stringify(jwks),
  };
}
