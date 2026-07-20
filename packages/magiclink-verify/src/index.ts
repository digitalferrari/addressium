/**
 * Hardened reference verifier for addressium magic-link tokens.
 *
 * This is the single most security-sensitive piece of the integration, so it
 * ships as copy-paste-ready code: the operator's MAIN WEBSITE runs this to
 * verify the token before establishing a lite session (docs/SECURITY.md §4.1,
 * ARCHITECTURE.md §12). It runs unchanged in Node (a Cognito custom-auth Lambda)
 * and in the browser (the CloudFront-cached page).
 *
 * WHY THIS MATTERS — the token is verified with a PUBLIC key, so the classic
 * attack is algorithm confusion (RFC 8725 §2.1, §3.1): an attacker forges an
 * HS256 token using the public key bytes as the HMAC secret, or sends
 * `alg: none`. The mitigation is to PIN the algorithm to ES256 and never let the
 * token header choose the algorithm or key type. `jose` enforces this when we
 * pass `algorithms: ["ES256"]` — do not remove it.
 */
import {
  createRemoteJWKSet,
  createLocalJWKSet,
  jwtVerify,
  type JWTPayload,
  type JSONWebKeySet,
} from "jose";

export interface MagicLinkClaims extends JWTPayload {
  /** The subscriber's Cognito subject in the shared pool. */
  sub: string;
  /** Lite access only. */
  scope: "content:read";
  /** Session origin marker; must include "magic_link". */
  amr: string[];
  /** Coarse content entitlement. */
  entitlement: "free" | "paid";
  /** Freshness stamp for `entitlement` (ISO-8601). */
  entitlement_asof?: string;
}

export interface VerifyOptions {
  /** Expected issuer (this addressium deployment / org). */
  issuer: string;
  /** Expected audience (your site). */
  audience: string;
  /** Allowed clock skew, seconds. Default 30. */
  clockToleranceSec?: number;
  /**
   * Key source — exactly one of:
   *  - `jwksUri`: the org's remote JWKS endpoint (server-side / production).
   *  - `jwks`: an inline public JWK set (browser-embedded key, or tests).
   */
  jwksUri?: string;
  jwks?: JSONWebKeySet;
}

export class MagicLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MagicLinkError";
  }
}

type KeyResolver = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;

const remoteCache = new Map<string, KeyResolver>();
const localCache = new Map<string, KeyResolver>();

function resolveKeySet(opts: VerifyOptions): KeyResolver {
  if (opts.jwksUri && opts.jwks) {
    throw new MagicLinkError("provide either jwksUri or jwks, not both");
  }
  if (opts.jwksUri) {
    let set = remoteCache.get(opts.jwksUri);
    if (!set) {
      set = createRemoteJWKSet(new URL(opts.jwksUri));
      remoteCache.set(opts.jwksUri, set);
    }
    return set;
  }
  if (opts.jwks) {
    const key = JSON.stringify(opts.jwks);
    let set = localCache.get(key);
    if (!set) {
      set = createLocalJWKSet(opts.jwks);
      localCache.set(key, set);
    }
    return set;
  }
  throw new MagicLinkError("no key source: set jwksUri or jwks");
}

/**
 * Verify a magic-link token and return its claims. Throws MagicLinkError on any
 * failure — callers MUST treat a throw as "no session; show the wall".
 *
 * Never trust an unverified decode. Never widen `algorithms`.
 */
export async function verifyMagicLinkToken(
  token: string,
  opts: VerifyOptions,
): Promise<MagicLinkClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, resolveKeySet(opts), {
      // RFC 8725: pin the algorithm; reject alg:none and all symmetric algs.
      algorithms: ["ES256"],
      issuer: opts.issuer,
      audience: opts.audience,
      clockTolerance: opts.clockToleranceSec ?? 30,
    }));
  } catch (err) {
    throw new MagicLinkError(`token verification failed: ${(err as Error).message}`);
  }

  // Required claims (checked explicitly for cross-version robustness).
  if (typeof payload.exp !== "number") {
    throw new MagicLinkError("missing exp");
  }
  const claims = payload as MagicLinkClaims;

  // Defense in depth: a magic-link session is LITE and must never be elevated.
  // The caller still has to gate profile/account behind step-up auth.
  if (claims.scope !== "content:read") {
    throw new MagicLinkError("unexpected scope: magic-link tokens are content:read only");
  }
  if (!Array.isArray(claims.amr) || !claims.amr.includes("magic_link")) {
    throw new MagicLinkError("missing amr: magic_link");
  }
  if (claims.entitlement !== "free" && claims.entitlement !== "paid") {
    throw new MagicLinkError("missing/invalid entitlement");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new MagicLinkError("missing sub");
  }
  return claims;
}

/**
 * Convenience: `null` instead of throwing, when you only need to decide whether
 * to drop the reg/paywall overlay (graceful fallback to the wall).
 */
export async function tryVerifyMagicLinkToken(
  token: string,
  opts: VerifyOptions,
): Promise<MagicLinkClaims | null> {
  try {
    return await verifyMagicLinkToken(token, opts);
  } catch {
    return null;
  }
}
