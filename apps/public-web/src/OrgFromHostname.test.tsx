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
import { resetApiBase } from "./api-base.js";

/**
 * Every page load first probes `/api/version` to learn whether this
 * distribution forwards `/api/*` to the API (#294). A JSON reply means
 * same-origin calls; anything else falls back to the absolute API URL.
 */
const noApiBehaviour = () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetApiBase();
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
    String(url).includes("/api/version")
      ? noApiBehaviour()
      : new Response(JSON.stringify({ orgId: "booklense", name: "Booklense" }), { status: 200 }),
  );
  globalThis.fetch = fetchMock as never;

  render(<App />);
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));

  // It asks about the host in the address bar — the one thing that differs
  // between two orgs served by the same bundle.
  const called = fetchMock.mock.calls.map((c) => String(c[0]));
  expect(called.some((u) => u.includes("/public/site?host=newsletter.booklense.com"))).toBe(true);
  // And the form renders once the org is known.
  await screen.findByRole("button", { name: /subscribe/i });
});

test("an unconfigured host says so instead of guessing an org", async () => {
  // The dangerous direction. A default org here would post a real signup to a
  // publication the visitor never chose.
  globalThis.fetch = vi.fn(async (url: string) =>
    String(url).includes("/api/version")
      ? noApiBehaviour()
      : new Response(JSON.stringify({ error: "no organization is configured for this host" }), { status: 404 }),
  ) as never;

  render(<App />);
  expect(await screen.findByText(/not configured yet/i)).toBeInTheDocument();
  // No form at all — nothing to submit to the wrong place.
  expect(screen.queryByRole("button", { name: /subscribe/i })).toBeNull();
});

test("a failed lookup does not render a submittable form", async () => {
  globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as never;
  // The probe fails too, which is correct: it falls back to the build-time base
  // and the org lookup then fails on its own.

  render(<App />);
  await waitFor(() => expect(screen.queryByRole("button", { name: /subscribe/i })).toBeNull());
});

test("a build-time org id never seeds the form on a real host", async () => {
  // The flash-of-wrong-org bug. Seeding state from `VITE_ORG_ID` meant a bundle
  // built with that variable rendered the PREVIOUS org's form for one frame
  // before the lookup resolved — on a bundle shared by every org, that is a
  // signup form briefly pointed at the wrong publication.
  //
  // Found in the live bundle: `useState("identithing-newsletter")` was still
  // compiled in after the runtime lookup shipped.
  vi.stubEnv("VITE_ORG_ID", "some-other-org");
  let resolve: (r: Response) => void = () => {};
  globalThis.fetch = vi.fn((url: string) =>
    String(url).includes("/api/version")
      ? Promise.resolve(noApiBehaviour())
      : new Promise<Response>((r) => { resolve = r; }),
  ) as never;

  render(<App />);

  // While the lookup is in flight there is NO form — not a form for the baked
  // id. "Loading" is the honest state.
  expect(screen.queryByRole("button", { name: /subscribe/i })).toBeNull();
  await screen.findByText(/loading/i);

  resolve(new Response(JSON.stringify({ orgId: "booklense", name: "Booklense" }), { status: 200 }));
  await screen.findByRole("button", { name: /subscribe/i });
});
