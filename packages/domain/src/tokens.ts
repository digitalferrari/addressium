/**
 * Token implementations for the slice.
 *
 * - Confirmation token (double opt-in): an internal, addressium-only HMAC token.
 *   Not a JWT — it never leaves our system and only proves "this email clicked
 *   confirm". Signed with a secret from Secrets Manager (docs/SECURITY.md §4.6).
 * - Magic-link token: the per-recipient ES256 JWT for editorial links, minted
 *   with a per-org KMS key in production. Verified by @addressium/magiclink-verify.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
// jose 6 removed `KeyLike` in favour of `CryptoKey`, the Web Crypto type every
// supported runtime exposes. Same thing by a name that is now standard rather
// than jose's own (#152).
import { SignJWT, type CryptoKey } from "jose";
import type { Clock, ConfirmationTokenSigner, ConfirmClaims, MagicLinkSigner } from "./ports.js";

export class SystemClock implements Clock {
  now() {
    return new Date();
  }
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64url");

type ConfirmPayload = ConfirmClaims;

/**
 * A token this deployment can no longer verify because the key that signed it
 * has been retired (#234).
 *
 * Distinguished from a bad signature deliberately. A forged token and a token
 * signed with a key we deliberately stopped keeping are the same HMAC failure
 * but completely different events: one is an attack, the other is our own
 * retirement decision reaching someone's inbox. The unsubscribe path branches on
 * this to offer a working alternative rather than saying "invalid link" to
 * somebody trying to exercise a legal right.
 */
export class RetiredKeyError extends Error {
  constructor(readonly kid: string) {
    super(`confirmation token signed by retired key ${kid}`);
    this.name = "RetiredKeyError";
  }
}

/** A token whose `exp` has passed. Also actionable, also not an attack. */
export class TokenExpiredError extends Error {
  constructor() {
    super("confirmation token expired");
    this.name = "TokenExpiredError";
  }
}

/** One HMAC key in the confirmation keyring. */
export interface ConfirmKey {
  /** Short opaque identifier carried in the token so verification is O(1). */
  kid: string;
  secret: string;
}

/**
 * Derive a stable kid from key material.
 *
 * Truncated sha256 rather than a counter, so the id is a function of the key
 * itself: two deployments that somehow share material agree on the kid, and a
 * kid never silently refers to different bytes after a manual secret edit. It
 * leaks nothing — 12 hex characters of a digest over a high-entropy secret is
 * not a meaningful attack surface, and the kid is public in the token anyway.
 */
export function deriveKid(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

/**
 * Parse the Secrets Manager value into a keyring, newest key first (#234).
 *
 * Two accepted shapes, and the second is not legacy cruft — it is the bootstrap:
 *
 * - `{"keys":[{"kid":"…","secret":"…"}, …]}` — what the rotation function writes.
 * - a bare string — what CloudFormation generates on the very first deploy,
 *   before anything has ever rotated. Treated as a single key with a derived
 *   kid, so a fresh install works with no rotation infrastructure in place.
 *
 * A malformed JSON keyring throws rather than falling back to "treat the whole
 * blob as one secret". The fallback would appear to work — it produces a signer,
 * and new links verify — while silently orphaning every previously issued token,
 * which is precisely the failure this issue exists to prevent.
 */
export function parseKeyring(secretValue: string): ConfirmKey[] {
  const trimmed = secretValue.trim();
  if (!trimmed.startsWith("{")) {
    if (!trimmed) throw new Error("confirmation secret is empty");
    return [{ kid: deriveKid(trimmed), secret: trimmed }];
  }
  const parsed = JSON.parse(trimmed) as { keys?: unknown };
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw new Error("confirmation keyring has no keys");
  }
  return parsed.keys.map((k, i) => {
    const key = k as { kid?: unknown; secret?: unknown };
    if (typeof key.secret !== "string" || !key.secret) {
      throw new Error(`confirmation keyring entry ${i} has no secret`);
    }
    return { kid: typeof key.kid === "string" && key.kid ? key.kid : deriveKid(key.secret), secret: key.secret };
  });
}

/**
 * HMAC confirmation-token signer over a KEYRING (#234).
 *
 * Signs with the newest key; verifies against every key it holds. Tokens carry
 * their `kid`, so verification is a map lookup rather than N HMACs.
 *
 * Why a keyring at all: this one secret signs two things that live in inboxes
 * for a very long time — the double opt-in link, clicked days later, and the
 * RFC 8058 one-click unsubscribe link, which is in EVERY message ever sent and
 * which the law requires to work. A single-key signer made the secret
 * unrotatable in any real sense: rotating it invalidated every outstanding link
 * at the instant of rotation, including unsubscribe links in two-year-old
 * archived mail.
 *
 * **The overlap window is the keyring, and retiring a key is a deliberate act.**
 * Rotation PREPENDS; it never drops. Unsubscribe tokens carry a five-year TTL
 * (`UNSUB_TOKEN_TTL_SECONDS` in the sender), so a key stops being load-bearing
 * five years after the last message signed with it went out — not on any
 * schedule a rotation Lambda should decide on its own. At annual rotation that
 * is six keys, and verification cost is unchanged because the kid selects one.
 */
export class HmacConfirmationSigner implements ConfirmationTokenSigner {
  private readonly keys: ConfirmKey[];
  private readonly byKid: Map<string, ConfirmKey>;

  /** Accepts a raw secret (single key) or a parsed keyring, newest first. */
  constructor(material: string | ConfirmKey[]) {
    this.keys = typeof material === "string" ? parseKeyring(material) : material;
    if (this.keys.length === 0) throw new Error("confirmation keyring has no keys");
    this.byKid = new Map(this.keys.map((k) => [k.kid, k]));
  }

  /** The kid new tokens are signed with — the newest key. */
  get activeKid(): string {
    return this.keys[0]!.kid;
  }

  /** Every kid this signer will still accept. */
  get acceptedKids(): string[] {
    return this.keys.map((k) => k.kid);
  }

  private mac(secret: string, body: string): Buffer {
    return createHmac("sha256", secret).update(body).digest();
  }

  sign(payload: ConfirmPayload): string {
    const key = this.keys[0]!;
    const body = b64url(JSON.stringify(payload));
    // The kid is part of the SIGNED body, not just a prefix: without that, an
    // attacker could swap the kid on a valid token to steer verification at a
    // different key. It fails either way here, but binding it removes the
    // question rather than relying on the HMAC to answer it.
    const sig = b64url(this.mac(key.secret, `${key.kid}.${body}`));
    return `${key.kid}.${body}.${sig}`;
  }

  /**
   * Verify a token and REQUIRE its scope (#74).
   *
   * Separate from `verify` so the requirement is explicit at every call site.
   * The default scope is `confirm`, which is what tokens minted before the
   * preference centre carry — so an old confirmation link keeps working and a
   * management link cannot be presented in its place.
   */
  verifyScoped(token: string, scope: "confirm" | "manage"): ConfirmPayload {
    const payload = this.verify(token);
    if ((payload.scope ?? "confirm") !== scope) {
      // Named for the reader of a log line, not for the holder of the token:
      // the response this produces must never say which scope was expected.
      throw new Error(`token scope mismatch: expected ${scope}`);
    }
    return payload;
  }

  verify(token: string): ConfirmPayload {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed confirmation token");
    const [kid, body, sig] = parts as [string, string, string];
    if (!kid || !body || !sig) throw new Error("malformed confirmation token");

    const key = this.byKid.get(kid);
    // Named separately from a signature failure — see RetiredKeyError. Checked
    // before any HMAC work, so an unknown kid costs nothing.
    if (!key) throw new RetiredKeyError(kid);

    const expected = b64url(this.mac(key.secret, `${kid}.${body}`));
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    // Timing-safe comparison (docs/SECURITY.md §4.6).
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("bad confirmation signature");
    }
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConfirmPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) throw new TokenExpiredError();
    return payload;
  }
}

/**
 * The keyring a rotation writes back: a fresh key at the front, keeping the rest
 * (#234).
 *
 * Pure, so the property that actually matters — that rotation NEVER drops a key
 * a live link might still need — is a unit test rather than something discovered
 * when an unsubscribe link stops working.
 *
 * `maxKeys` exists only as a runaway guard for a deployment that rotates far
 * more often than the design assumes; it defaults high enough that ordinary
 * rotation never reaches it, and dropping a key is logged by the caller.
 */
export function rotateKeyring(current: ConfirmKey[], newSecret: string, maxKeys = 12): ConfirmKey[] {
  const fresh: ConfirmKey = { kid: deriveKid(newSecret), secret: newSecret };
  // Re-rotating to the same material would otherwise produce a duplicate kid and
  // shadow the existing entry in the lookup map.
  const rest = current.filter((k) => k.kid !== fresh.kid);
  return [fresh, ...rest].slice(0, Math.max(1, maxKeys));
}

/** Serialize a keyring for Secrets Manager. */
export const serializeKeyring = (keys: ConfirmKey[]): string => JSON.stringify({ keys });

export interface MagicLinkSignerConfig {
  privateKey: CryptoKey;
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
    externalId: string;
    entitlement: "free" | "paid";
    entitlementAsof?: string;
  }): Promise<string> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({
      scope: "content:read",
      amr: ["magic_link"],
      // The reader's `sub` in the org's linked Cognito pool. Named
      // `external_sub` — external to addressium, and NOT `sub`, which stays
      // addressium's own subscriber id (§4.9). With both plus `entitlement`, a
      // paywall resolves the reader and their access with zero calls back here.
      // The claim set stays closed: adding one is a deliberate, versioned act.
      external_sub: input.externalId,
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
