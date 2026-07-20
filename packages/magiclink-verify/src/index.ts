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
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

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
  /** The org's JWKS endpoint (per-org signing key). */
  jwksUri: string;
  /** Expected issuer (this addressium deployment / org). */
  issuer: string;
  /** Expected audience (your site). */
  audience: string;
  /** Allowed clock skew, seconds. Default 30. */
  clockToleranceSec?: number;
}

export class MagicLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MagicLinkError";
  }
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(uri: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, set);
  }
  return set;
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
    ({ payload } = await jwtVerify(token, jwksFor(opts.jwksUri), {
      // RFC 8725: pin the algorithm; reject alg:none and all symmetric algs.
      algorithms: ["ES256"],
      issuer: opts.issuer,
      audience: opts.audience,
      clockTolerance: opts.clockToleranceSec ?? 30,
      requiredClaims: ["sub", "scope", "amr", "entitlement", "exp"],
    }));
  } catch (err) {
    throw new MagicLinkError(`token verification failed: ${(err as Error).message}`);
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
  return claims;
}

/**
 * Convenience: `true`/`false` instead of throwing, when you only need to decide
 * whether to drop the reg/paywall overlay (graceful fallback to the wall).
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
