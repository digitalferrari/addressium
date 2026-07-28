/**
 * Browser drop-in: read the token, verify it, hand back a session (#215).
 *
 * `index.ts` is the verifier and it is not the integration. It returns raw JWT
 * claims and throws, so a site still has to find the token in the URL, decide
 * what a throw means, remove the credential from the address bar, and re-derive
 * all of it on the next page — the half that is easy to get subtly wrong, and
 * the half we were leaving to every integrator to write from scratch.
 *
 * THREE THINGS THIS EXISTS TO GET RIGHT, none of them cryptography:
 *
 *  1. **It never throws.** A paywall's failure path is "show the wall", not
 *     "unhandled rejection blanks the article". Every outcome is a session
 *     object with an enumerated `reason`.
 *  2. **The token leaves the URL.** A magic link in `location.hash` survives in
 *     the address bar, in a copy-pasted link, in a screenshot, and in anything
 *     that reads `document.location`. `history.replaceState` removes it without
 *     a navigation, before the site's own code ever runs.
 *  3. **Zero network calls.** With an embedded JWKS the whole verification is
 *     local, so a CDN-cached page can decide entitlement with no request to
 *     addressium — which is the entire point of signing the entitlement into the
 *     token in the first place.
 *
 * The cryptography is `index.ts`'s and is not reimplemented here.
 */
import {
  MagicLinkError,
  verifyMagicLinkToken,
  type MagicLinkClaims,
  type MagicLinkFailure,
  type VerifyOptions,
} from "./index.js";

/**
 * Why there is (or is not) a session. A superset of `MagicLinkFailure`: the
 * outcomes below are about the page, not the token.
 */
export type SessionReason =
  | "verified"
  | "restored"
  | "no_token"
  | MagicLinkFailure;

/**
 * What the site's own code depends on. Deliberately NOT the JWT claims: `sub`
 * meaning "addressium subscriber" while `external_sub` means "your Cognito user"
 * is exactly the confusion that puts the wrong id in someone's analytics.
 */
export interface MagicLinkSession {
  authenticated: boolean;
  reason: SessionReason;
  /** addressium's durable subscriber id. */
  subscriberId?: string;
  /** The reader's `sub` in YOUR Cognito pool — the join key to your directory. */
  poolSub?: string;
  entitlement?: "free" | "paid";
  /** When the entitlement was last synced from your source of truth (ISO-8601). */
  entitlementAsOf?: string;
  /** ISO-8601. The session is over at this instant; nothing renews it client-side. */
  expiresAt?: string;
}

/**
 * The exact browser surface this module touches, declared rather than pulled in
 * via `lib: ["DOM"]`. Three globals and four methods is the whole footprint, and
 * writing it down keeps it that way — with the DOM lib loaded, reaching for
 * `document` or `fetch` would typecheck silently, and this module must do
 * neither.
 */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface LocationLike {
  href: string;
  hash: string;
}
export interface HistoryLike {
  replaceState(data: unknown, title: string, url: string): void;
}

declare const location: LocationLike | undefined;
declare const history: HistoryLike | undefined;
declare const sessionStorage: SessionStorageLike | undefined;

/** Seams, so this is testable without a browser and honest about what it touches. */
export interface BrowserEnv {
  location?: LocationLike;
  history?: HistoryLike;
  storage?: SessionStorageLike;
  now?: () => number;
}

export interface ConsumeOptions extends VerifyOptions, BrowserEnv {
  /** Fragment parameter carrying the token. Default `tok`. */
  fragmentParam?: string;
  /**
   * Remove the token from the URL once read. Default true, and turning it off
   * means the credential stays in the address bar for as long as the tab lives.
   */
  stripToken?: boolean;
  /**
   * Keep the session in `sessionStorage` so an in-site navigation does not need
   * the token again. Default true. sessionStorage, not localStorage: the session
   * should not outlive the tab, and localStorage is shared across tabs and
   * survives a browser restart.
   */
  cache?: boolean;
  cacheKey?: string;
}

const DEFAULT_KEY = "addressium.magiclink.session";
const NO_SESSION = (reason: SessionReason): MagicLinkSession => ({ authenticated: false, reason });

const env = (o: ConsumeOptions) => ({
  location: o.location ?? (typeof location !== "undefined" ? location : undefined),
  history: o.history ?? (typeof history !== "undefined" ? history : undefined),
  storage:
    o.storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined),
  now: o.now ?? Date.now,
});

function sessionOf(claims: MagicLinkClaims): MagicLinkSession {
  return {
    authenticated: true,
    reason: "verified",
    subscriberId: claims.sub,
    poolSub: claims.external_sub,
    entitlement: claims.entitlement,
    ...(claims.entitlement_asof ? { entitlementAsOf: claims.entitlement_asof } : {}),
    expiresAt: new Date((claims.exp as number) * 1000).toISOString(),
  };
}

/** Read the token from the fragment. Query string is deliberately not consulted. */
export function readToken(hash: string, param = "tok"): string | undefined {
  // The fragment, not the query string: a fragment is never sent to a server,
  // so the token does not land in the site's access logs, its CDN logs, or any
  // referrer header on the way out.
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const value = new URLSearchParams(raw).get(param);
  return value && value.length > 0 ? value : undefined;
}

/** Remove just the token parameter, preserving any other fragment state. */
export function stripTokenFromUrl(href: string, param = "tok"): string {
  const hashAt = href.indexOf("#");
  if (hashAt < 0) return href;
  const params = new URLSearchParams(href.slice(hashAt + 1));
  if (!params.has(param)) return href;
  params.delete(param);
  const rest = params.toString();
  // A site may keep its own state in the fragment (a deep link, a tab); removing
  // the whole hash would break it. An empty remainder drops the "#" as well, so
  // the address bar does not keep a bare marker of what was there.
  return href.slice(0, hashAt) + (rest ? `#${rest}` : "");
}

/**
 * Read, verify, store, and clean the URL. Never throws.
 *
 * Order matters: the token is stripped BEFORE verification resolves, so a slow
 * or failing verification cannot leave the credential in the address bar.
 */
export async function consume(opts: ConsumeOptions): Promise<MagicLinkSession> {
  const e = env(opts);
  const param = opts.fragmentParam ?? "tok";
  const key = opts.cacheKey ?? DEFAULT_KEY;
  const useCache = opts.cache !== false;

  const token = e.location ? readToken(e.location.hash, param) : undefined;

  if (token && opts.stripToken !== false && e.location && e.history) {
    const cleaned = stripTokenFromUrl(e.location.href, param);
    if (cleaned !== e.location.href) {
      // replaceState, not assignment: no navigation, no history entry the Back
      // button can return the reader to with the token still attached.
      try {
        e.history.replaceState(null, "", cleaned);
      } catch {
        // A sandboxed iframe or a file:// page can refuse this. Not fatal — but
        // never a reason to skip verification.
      }
    }
  }

  if (!token) {
    const restored = useCache ? restore(key, e.storage, e.now) : undefined;
    return restored ?? NO_SESSION("no_token");
  }

  let session: MagicLinkSession;
  try {
    session = sessionOf(await verifyMagicLinkToken(token, opts));
  } catch (err) {
    // A refused token invalidates whatever was cached: a reader whose
    // entitlement was revoked must not keep reading on a stale session.
    if (useCache) e.storage?.removeItem(key);
    return NO_SESSION(err instanceof MagicLinkError ? err.code : "malformed");
  }

  if (useCache) {
    try {
      e.storage?.setItem(key, JSON.stringify(session));
    } catch {
      // Storage disabled or full. The session is still valid for this page.
    }
  }
  return session;
}

/**
 * The cached session, without re-reading the URL. Synchronous, so a render path
 * can call it — the whole reason to cache at all.
 */
export function currentSession(opts: BrowserEnv & { cacheKey?: string } = {}): MagicLinkSession {
  const e = env(opts as ConsumeOptions);
  return restore(opts.cacheKey ?? DEFAULT_KEY, e.storage, e.now) ?? NO_SESSION("no_token");
}

/** Forget the session — sign-out, or an entitlement change the site was told about. */
export function clearSession(opts: BrowserEnv & { cacheKey?: string } = {}): void {
  env(opts as ConsumeOptions).storage?.removeItem(opts.cacheKey ?? DEFAULT_KEY);
}

function restore(
  key: string,
  storage: BrowserEnv["storage"],
  now: () => number,
): MagicLinkSession | undefined {
  let raw: string | null | undefined;
  try {
    raw = storage?.getItem(key);
  } catch {
    return undefined; // storage disabled
  }
  if (!raw) return undefined;

  let cached: MagicLinkSession;
  try {
    cached = JSON.parse(raw) as MagicLinkSession;
  } catch {
    storage?.removeItem(key);
    return undefined;
  }
  // The cache is a copy of a verified result, not evidence: it can only ever
  // report a session the token already granted, and it expires exactly when the
  // token does. Anyone who edits sessionStorage to extend it has only fooled
  // their own browser — the server never trusted this.
  if (!cached.authenticated || !cached.expiresAt || Date.parse(cached.expiresAt) <= now()) {
    storage?.removeItem(key);
    return undefined;
  }
  return { ...cached, reason: "restored" };
}
