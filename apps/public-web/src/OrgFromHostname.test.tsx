/**
 * One bundle, every org (#294).
 *
 * `VITE_ORG_ID` was substituted into the JavaScript by Vite at BUILD time, so
 * the shipped bundle carried a literal org id — verified against the live
 * bundle, which contained the string `identithing-newsletter` exactly once.
 * That meant one build per org: ten orgs, ten builds, ten publishes, and ten
 * chances for one to go stale.
 *
 * The page now asks which org serves its hostname. The behaviours worth pinning
 * are what happens when it CANNOT find out — because the tempting failure mode
 * (fall back to some default org) would subscribe a person to a publication
 * they never visited.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  Object.defineProperty(window, "location", {
    value: new URL("https://newsletter.booklense.com/"),
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

test("the page resolves its org from the hostname it was loaded on", async () => {
  const fetchMock = vi.fn(async (url: string) =>
    new Response(JSON.stringify({ orgId: "booklense", name: "Booklense" }), { status: 200 }),
  );
  globalThis.fetch = fetchMock as never;

  render(<App />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());

  // It asks about the host in the address bar — the one thing that differs
  // between two orgs served by the same bundle.
  const called = String(fetchMock.mock.calls[0]![0]);
  expect(called).toContain("/public/site?host=newsletter.booklense.com");
  // And the form renders once the org is known.
  await screen.findByRole("button", { name: /subscribe/i });
});

test("an unconfigured host says so instead of guessing an org", async () => {
  // The dangerous direction. A default org here would post a real signup to a
  // publication the visitor never chose.
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ error: "no organization is configured for this host" }), { status: 404 }),
  ) as never;

  render(<App />);
  expect(await screen.findByText(/not configured yet/i)).toBeInTheDocument();
  // No form at all — nothing to submit to the wrong place.
  expect(screen.queryByRole("button", { name: /subscribe/i })).toBeNull();
});

test("a failed lookup does not render a submittable form", async () => {
  globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as never;

  render(<App />);
  await waitFor(() => expect(screen.queryByRole("button", { name: /subscribe/i })).toBeNull());
});
