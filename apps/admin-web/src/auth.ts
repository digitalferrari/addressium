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
}

const KEY = "addressium.tokens";

export function getTokens(): Tokens | null {
  const raw = sessionStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Tokens) : null;
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
  sessionStorage.setItem("pkce.verifier", verifier);
  sessionStorage.setItem("pkce.state", state);
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
  if (params.get("state") !== sessionStorage.getItem("pkce.state")) throw new Error("state mismatch");
  const verifier = sessionStorage.getItem("pkce.verifier") ?? "";
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
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const json = (await res.json()) as { id_token: string; access_token: string };
  sessionStorage.setItem(KEY, JSON.stringify({ idToken: json.id_token, accessToken: json.access_token }));
  window.history.replaceState({}, "", CFG.redirectUri);
  return true;
}

export function logout(): void {
  sessionStorage.removeItem(KEY);
}

/** Decode a JWT payload (no verification — the API is the boundary). */
export function decodeClaims(token: string): Record<string, string> {
  const part = token.split(".")[1];
  if (!part) return {};
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as Record<string, string>;
}
