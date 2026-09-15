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

  async jwks(keyArn: string, kid: string): Promise<{ keys: Jwk[] }>;
  async jwks(keys: Array<{ kmsKeyArn: string; kid: string }>): Promise<{ keys: Jwk[] }>;
  async jwks(keyOrKeys: string | Array<{ kmsKeyArn: string; kid: string }>, kid?: string): Promise<{ keys: Jwk[] }> {
    const keys = typeof keyOrKeys === "string" ? [{ kmsKeyArn: keyOrKeys, kid: kid! }] : keyOrKeys;
    return {
      keys: await Promise.all(keys.map(async (key) => {
        const res = await this.client.send(new GetPublicKeyCommand({ KeyId: key.kmsKeyArn }));
        if (!res.PublicKey) throw new Error("KMS returned no public key");
        return spkiDerToJwk(res.PublicKey, key.kid);
      })),
    };
  }
}
