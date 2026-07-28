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
  /**
   * addressium's durable subscriber id (`Subscriber.sub`) — NOT a Cognito
   * subject. The matching pool subject is `external_sub` (docs/ARCHITECTURE.md
   * §4.10, §12).
   */
  sub: string;
  /**
   * The reader's `sub` in the org's own Cognito user pool. This is what lets a
   * paywall resolve the reader against its OWN directory with no call back to
   * addressium — the point of the whole token. Tokens are only minted for a
   * subscriber whose pool account is known, so this claim is always present.
   */
  external_sub: string;
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

/**
 * Why a token was refused (#215).
 *
 * An enumerated code rather than the message, because a paywall has to BRANCH on
 * this — "expired, offer a fresh link" and "forged, show nothing" are different
 * product decisions — and branching on `err.message.includes(...)` breaks the
 * first time a dependency rewords its error. The message stays human-readable
 * for logs; this is what code reads.
 */
export type MagicLinkFailure =
  | "expired"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "not_yet_valid"
  | "malformed"
  | "wrong_scope"
  | "missing_claim"
  | "no_key_source";

export class MagicLinkError extends Error {
  constructor(
    message: string,
    /** Defaults to `malformed`: an unclassified failure is still a refusal. */
    public readonly code: MagicLinkFailure = "malformed",
  ) {
    super(message);
    this.name = "MagicLinkError";
  }
}

/**
 * Map a `jose` error to one of ours. Reads `err.code`, the documented stable
 * identifier, rather than the message text — the message is prose and changes.
 */
function classify(err: unknown): MagicLinkFailure {
  const code = (err as { code?: string }).code ?? "";
  const claim = (err as { claim?: string }).claim ?? "";
  switch (code) {
    case "ERR_JWT_EXPIRED":
      return "expired";
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
    case "ERR_JWKS_NO_MATCHING_KEY":
    case "ERR_JWKS_MULTIPLE_MATCHING_KEYS":
      return "bad_signature";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      if (claim === "iss") return "wrong_issuer";
      if (claim === "aud") return "wrong_audience";
      if (claim === "nbf") return "not_yet_valid";
      return "missing_claim";
    default:
      // Includes `alg:none` and algorithm-confusion attempts, which jose rejects
      // as a header/format failure before any signature check runs.
      return "malformed";
  }
}

type KeyResolver = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;

const remoteCache = new Map<string, KeyResolver>();
const localCache = new Map<string, KeyResolver>();

function resolveKeySet(opts: VerifyOptions): KeyResolver {
  if (opts.jwksUri && opts.jwks) {
    throw new MagicLinkError("provide either jwksUri or jwks, not both", "no_key_source");
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
  throw new MagicLinkError("no key source: set jwksUri or jwks", "no_key_source");
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
    if (err instanceof MagicLinkError) throw err; // key-source misconfiguration
    throw new MagicLinkError(
      `token verification failed: ${(err as Error).message}`,
      classify(err),
    );
  }

  // Required claims (checked explicitly for cross-version robustness).
  if (typeof payload.exp !== "number") {
    throw new MagicLinkError("missing exp", "missing_claim");
  }
  const claims = payload as MagicLinkClaims;

  // Defense in depth: a magic-link session is LITE and must never be elevated.
  // The caller still has to gate profile/account behind step-up auth.
  if (claims.scope !== "content:read") {
    throw new MagicLinkError(
      "unexpected scope: magic-link tokens are content:read only",
      "wrong_scope",
    );
  }
  if (!Array.isArray(claims.amr) || !claims.amr.includes("magic_link")) {
    throw new MagicLinkError("missing amr: magic_link", "missing_claim");
  }
  if (claims.entitlement !== "free" && claims.entitlement !== "paid") {
    throw new MagicLinkError("missing/invalid entitlement", "missing_claim");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new MagicLinkError("missing sub", "missing_claim");
  }
  // Fail CLOSED, like every other claim above: a token with no pool subject
  // cannot identify the reader in the operator's directory, and silently
  // returning one would push that decision into every integrator's code.
  if (typeof claims.external_sub !== "string" || claims.external_sub.length === 0) {
    throw new MagicLinkError("missing external_sub", "missing_claim");
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
