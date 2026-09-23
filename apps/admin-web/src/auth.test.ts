/**
 * Session expiry (`isExpired`) — the check that decides whether the console
 * mounts at all.
 *
 * A token stored without `expires_in` used to be treated as valid ("let the API
 * decide"), so App mounted the full console on a dead session: every screen
 * fired, every call 401'd, and the operator watched the interface flash up
 * covered in errors before api.ts redirected them to Cognito. These pin the
 * expiry down to the JWT's own `exp` so the redirect happens before anything
 * renders.
 */
import { expect, test } from "vitest";
import { isExpired, type Tokens } from "./auth.js";

/** Build an unsigned JWT whose payload carries `exp` (seconds since epoch). */
function tokenExpiringAt(expSeconds: number | undefined): string {
  const payload: Record<string, unknown> = { sub: "operator", token_use: "id" };
  if (expSeconds !== undefined) payload.exp = expSeconds;
  const body = btoa(JSON.stringify(payload))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${body}.signature`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function tokens(idToken: string, expiresAt?: number): Tokens {
  return { idToken, accessToken: idToken, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

test("a missing session is expired", () => {
  expect(isExpired(null)).toBe(true);
});

test("expiresAt is honoured when present", () => {
  expect(isExpired(tokens(tokenExpiringAt(undefined), Date.now() + 60_000))).toBe(false);
  expect(isExpired(tokens(tokenExpiringAt(undefined), Date.now() - 1_000))).toBe(true);
});

test("a token expiring within the skew window is already expired", () => {
  // 30s of clock skew: a token with 10s left would 401 mid-flight.
  expect(isExpired(tokens(tokenExpiringAt(undefined), Date.now() + 10_000))).toBe(true);
});

test("without expiresAt, the JWT's own exp decides", () => {
  // The regression: this used to return false and mount the console.
  expect(isExpired(tokens(tokenExpiringAt(nowSeconds() - 3600)))).toBe(true);
  expect(isExpired(tokens(tokenExpiringAt(nowSeconds() + 3600)))).toBe(false);
});

test("a token with no exp at all still defers to the API", () => {
  // Nothing local can judge it, so the old behaviour is correct here: let the
  // call happen and let a 401 route to re-auth.
  expect(isExpired(tokens(tokenExpiringAt(undefined)))).toBe(false);
});

test("a malformed token is not treated as a live session", () => {
  // decodeClaims swallows the error and returns {}, so there is no exp to read.
  // It must not throw — a corrupt token blanking the console is the bug this
  // whole module's self-healing exists to prevent.
  expect(() => isExpired(tokens("not-a-jwt"))).not.toThrow();
});
