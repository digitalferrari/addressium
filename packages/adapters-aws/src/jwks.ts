/**
 * JWKS publishing for magic-link verification (docs/ARCHITECTURE.md §4.9, §12).
 *
 * The tokens service serves each org's public key as a JWK set so the main site
 * can verify tokens offline. KMS returns the public key as SPKI/DER; Node's
 * crypto exports it straight to JWK form.
 */
import { createPublicKey } from "node:crypto";
import { KMSClient, GetPublicKeyCommand } from "@aws-sdk/client-kms";

export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  kid: string;
  alg: "ES256";
  use: "sig";
}

/** Convert an SPKI/DER EC public key to a JWK, stamping kid/alg/use. */
export function spkiDerToJwk(der: Uint8Array, kid: string): Jwk {
  const jwk = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" }).export({
    format: "jwk",
  }) as Record<string, string>;
  return { ...jwk, kid, alg: "ES256", use: "sig" } as Jwk;
}

export class KmsJwksProvider {
  private readonly client: KMSClient;
  constructor(client?: KMSClient) {
    this.client = client ?? new KMSClient({});
  }

  async jwks(keyArn: string, kid: string): Promise<{ keys: Jwk[] }> {
    const res = await this.client.send(new GetPublicKeyCommand({ KeyId: keyArn }));
    if (!res.PublicKey) throw new Error("KMS returned no public key");
    return { keys: [spkiDerToJwk(res.PublicKey, kid)] };
  }
}
