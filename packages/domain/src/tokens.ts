/**
 * Token implementations for the slice.
 *
 * - Confirmation token (double opt-in): an internal, addressium-only HMAC token.
 *   Not a JWT — it never leaves our system and only proves "this email clicked
 *   confirm". Signed with a secret from Secrets Manager (docs/SECURITY.md §4.6).
 * - Magic-link token: the per-recipient ES256 JWT for editorial links, minted
 *   with a per-org KMS key in production. Verified by @addressium/magiclink-verify.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { SignJWT, type KeyLike } from "jose";
import type { Clock, ConfirmationTokenSigner, ConfirmClaims, MagicLinkSigner } from "./ports.js";

export class SystemClock implements Clock {
  now() {
    return new Date();
  }
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64url");

type ConfirmPayload = ConfirmClaims;

export class HmacConfirmationSigner implements ConfirmationTokenSigner {
  constructor(private readonly secret: string) {}

  private mac(body: string): Buffer {
    return createHmac("sha256", this.secret).update(body).digest();
  }

  sign(payload: ConfirmPayload): string {
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(this.mac(body));
    return `${body}.${sig}`;
  }

  verify(token: string): ConfirmPayload {
    const [body, sig] = token.split(".");
    if (!body || !sig) throw new Error("malformed confirmation token");
    const expected = b64url(this.mac(body));
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    // Timing-safe comparison (docs/SECURITY.md §4.6).
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("bad confirmation signature");
    }
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConfirmPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error("confirmation token expired");
    }
    return payload;
  }
}

export interface MagicLinkSignerConfig {
  privateKey: KeyLike;
  kid: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

export class JoseMagicLinkSigner implements MagicLinkSigner {
  constructor(
    private readonly cfg: MagicLinkSignerConfig,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async mint(input: {
    orgId: string;
    sub: string;
    entitlement: "free" | "paid";
    entitlementAsof?: string;
  }): Promise<string> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({
      scope: "content:read",
      amr: ["magic_link"],
      entitlement: input.entitlement,
      entitlement_asof: input.entitlementAsof,
    })
      .setProtectedHeader({ alg: "ES256", kid: this.cfg.kid })
      .setSubject(input.sub)
      .setIssuer(this.cfg.issuer)
      .setAudience(this.cfg.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + this.cfg.ttlSeconds)
      .sign(this.cfg.privateKey);
  }
}
