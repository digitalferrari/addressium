/**
 * KMS-backed magic-link signer (docs/SECURITY.md §4.1, §4.6).
 *
 * The per-org ES256 private key NEVER leaves KMS. We build the JWT signing input
 * ourselves and ask KMS to sign it; KMS returns a DER signature which
 * `buildEs256CompactJws` converts to the JOSE r||s form. The assembly path is
 * unit-tested in @addressium/domain against a local EC key.
 */
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { buildEs256CompactJws, type Clock, type MagicLinkSigner, SystemClock } from "@addressium/domain";

export interface KmsMagicLinkSignerConfig {
  /** KMS key id/ARN of the org's asymmetric ES256 signing key. */
  keyId: string;
  /** JWKS `kid` published for this key. */
  kid: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

export class KmsMagicLinkSigner implements MagicLinkSigner {
  private readonly client: KMSClient;

  constructor(
    private readonly cfg: KmsMagicLinkSignerConfig,
    private readonly clock: Clock = new SystemClock(),
    client?: KMSClient,
  ) {
    this.client = client ?? new KMSClient({});
  }

  async mint(input: {
    orgId: string;
    sub: string;
    entitlement: "free" | "paid";
    entitlementAsof?: string;
  }): Promise<string> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    return buildEs256CompactJws(
      { kid: this.cfg.kid },
      {
        sub: input.sub,
        scope: "content:read",
        amr: ["magic_link"],
        entitlement: input.entitlement,
        entitlement_asof: input.entitlementAsof,
        iss: this.cfg.issuer,
        aud: this.cfg.audience,
        iat: now,
        exp: now + this.cfg.ttlSeconds,
      },
      async (signingInput) => {
        const res = await this.client.send(
          new SignCommand({
            KeyId: this.cfg.keyId,
            Message: signingInput,
            MessageType: "RAW",
            SigningAlgorithm: "ECDSA_SHA_256",
          }),
        );
        if (!res.Signature) throw new Error("KMS returned no signature");
        return Buffer.from(res.Signature);
      },
    );
  }
}
