/**
 * The pre-authentication shell.
 *
 * An unauthenticated visit used to render the console — nav, screens and all —
 * which fired API calls that 401'd, so the operator saw the interface flash up
 * covered in errors before being redirected to Cognito. These assert that
 * nothing but the neutral "Signing in…" shell can reach the DOM before `authed`
 * is true, and that the redirect is automatic rather than a button.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const login = vi.fn(async () => undefined);

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  login,
  // Not local development: that path deliberately keeps the button.
  isLocalDevelopment: false,
  completeLoginIfPresent: vi.fn(async () => false),
}));

// The console must never mount pre-auth; if it does, this throws and the test
// fails with a clear reason rather than a confusing DOM assertion.
vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  api: new Proxy({}, {
    get() {
      throw new Error("api was called before authentication");
    },
  }),
}));

beforeEach(() => {
  login.mockClear();
  sessionStorage.clear();
});
afterEach(() => cleanup());

test("an unauthenticated visit redirects instead of showing a sign-in button", async () => {
  const { App } = await import("./App.js");
  render(<App />);

  await waitFor(() => expect(login).toHaveBeenCalledTimes(1));

  // The button is gone: the redirect is the landing experience now.
  expect(screen.queryByRole("button", { name: /sign in with cognito/i })).toBeNull();
});

test("no console chrome renders while unauthenticated", async () => {
  const { App } = await import("./App.js");
  render(<App />);

  await waitFor(() => expect(login).toHaveBeenCalled());

  // The neutral shell, and nothing that belongs to the signed-in console.
  expect(screen.getByText(/signing in/i)).toBeTruthy();
  for (const chrome of [/dashboard/i, /campaigns/i, /schedules/i, /sign out/i]) {
    expect(screen.queryByText(chrome)).toBeNull();
  }
});

test("the redirect is attempted only once", async () => {
  const { App } = await import("./App.js");
  const { rerender } = render(<App />);

  await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  rerender(<App />);
  await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
});

test("a failed redirect falls back to the sign-in card", async () => {
  // Cognito unreachable, or the SPA built without VITE_COGNITO_DOMAIN. A
  // permanently blank page would leave the operator with no control at all.
  login.mockRejectedValueOnce(new Error("hosted UI unreachable"));
  const { App } = await import("./App.js");
  render(<App />);

  await waitFor(() =>
    expect(screen.getByRole("button", { name: /sign in with cognito/i })).toBeTruthy(),
  );
});
