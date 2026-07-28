/**
 * Cognito Hosted UI login via Authorization Code + PKCE (docs/ARCHITECTURE.md
 * §4.1, §9.1). No client secret in the SPA; the code is exchanged for tokens at
 * the Cognito token endpoint. Tokens live in sessionStorage for the tab session.
 */
const CFG = {
  domain: import.meta.env.VITE_COGNITO_DOMAIN ?? "",
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "",
  redirectUri: import.meta.env.VITE_REDIRECT_URI ?? window.location.origin + "/",
  scope: "openid email profile",
};

export interface Tokens {
  idToken: string;
  accessToken: string;
  /** Absolute expiry (ms since epoch), derived from `expires_in` at exchange. */
  expiresAt?: number;
}

const KEY = "addressium.tokens";

const VERIFIER_KEY = "pkce.verifier";
const STATE_KEY = "pkce.state";

export function getTokens(): Tokens | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Tokens;
  } catch {
    // A corrupt value used to throw on every API call AND on render, with no
    // recovery path — the operator couldn't even reach Sign out. Self-heal.
    sessionStorage.removeItem(KEY);
    return null;
  }
}

/** Drop the stored tokens without ending the Cognito session (see `logout`). */
export function clearTokens(): void {
  sessionStorage.removeItem(KEY);
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

/** Redirect to the Hosted UI, stashing a PKCE verifier + state. */
export async function login(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const challenge = b64url(await sha256(verifier));
  const url = new URL(`https://${CFG.domain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CFG.clientId,
    redirect_uri: CFG.redirectUri,
    scope: CFG.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  window.location.assign(url.toString());
}

/** On redirect back, exchange ?code for tokens. Returns true if a login completed. */
export async function completeLoginIfPresent(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return false;
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY) ?? "";
  // Single-use: clear both before any await, so a replayed callback can't reuse
  // them and an injected script can't read them afterwards.
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  // `!expectedState` matters: without it a callback carrying no `state` in a
  // fresh tab compared null !== null and silently PASSED the CSRF check.
  if (!expectedState || params.get("state") !== expectedState) {
    window.history.replaceState({}, "", CFG.redirectUri);
    throw new Error("state mismatch");
  }
  const res = await fetch(`https://${CFG.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CFG.clientId,
      code,
      redirect_uri: CFG.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    // Clear `?code=` regardless, or a reload retries a consumed code forever.
    window.history.replaceState({}, "", CFG.redirectUri);
    throw new Error(`token exchange failed: ${res.status}`);
  }
  const json = (await res.json()) as { id_token: string; access_token: string; expires_in?: number };
  const expiresAt = json.expires_in ? Date.now() + json.expires_in * 1000 : undefined;
  sessionStorage.setItem(
    KEY,
    JSON.stringify({ idToken: json.id_token, accessToken: json.access_token, expiresAt }),
  );
  window.history.replaceState({}, "", CFG.redirectUri);
  return true;
}

/** True when the stored token is absent or past its expiry (with a small skew). */
export function isExpired(t: Tokens | null): boolean {
  if (!t) return true;
  if (t.expiresAt === undefined) return false; // legacy token: let the API decide
  return Date.now() >= t.expiresAt - 30_000;
}

/**
 * Full sign-out. Clearing sessionStorage alone left the Cognito Hosted-UI
 * session cookie intact, so the next "Sign in" returned the previous operator
 * fully authenticated with no password and NO MFA prompt (#169). Redirecting
 * through Cognito's /logout is what actually ends the session.
 */
export function logout(): void {
  sessionStorage.removeItem(KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  if (!CFG.domain || !CFG.clientId) return; // unconfigured (tests/local)
  const url = new URL(`https://${CFG.domain}/logout`);
  url.search = new URLSearchParams({
    client_id: CFG.clientId,
    logout_uri: CFG.redirectUri,
  }).toString();
  window.location.assign(url.toString());
}

/**
 * Decode a JWT payload (no verification — the API is the boundary).
 *
 * Never throws: a malformed token previously escaped a `useMemo` and blanked the
 * console. Decodes as UTF-8 so non-ASCII claims survive (`atob` yields a byte
 * string, which mangles e.g. "José").
 */
export function decodeClaims(token: string): Record<string, string> {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const bytes = Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
