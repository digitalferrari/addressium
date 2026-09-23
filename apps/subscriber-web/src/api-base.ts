/**
 * Where this page's API calls go (#294).
 *
 * Two deployment shapes, and the page works in both without a rebuild:
 *
 *  1. **An org's own distribution** with an `/api/*` behaviour forwarding to the
 *     HTTP API. Calls are then SAME-ORIGIN, so there is no CORS preflight at
 *     all, and `List-Unsubscribe` can point at the org's own domain — which
 *     matters because a one-click POST has to reach a real handler, and
 *     CloudFront-over-S3 answers POST with 403.
 *  2. **The shared distribution** (or `npm run dev`), where no such behaviour
 *     exists and the absolute API URL compiled in at build time is used.
 *
 * Probed rather than configured. A build-time flag would be one more value per
 * org to keep in sync, and getting it wrong fails in the browser — a page that
 * cannot reach its API at all — rather than at deploy time.
 *
 * `GET /api/version` is deliberately cheap and unauthenticated. A 404 from the
 * SPA's own catch-all (every unknown path returns index.html, so it answers 200
 * with HTML) is distinguished by content type, not status: a behaviour that is
 * NOT configured returns the SPA shell, which is not JSON.
 */
const BUILD_TIME_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

/** Resolved once per page load; every caller awaits the same promise. */
let probe: Promise<string> | undefined;

export function apiBase(): Promise<string> {
  probe ??= (async () => {
    try {
      const res = await fetch("/api/version", { method: "GET" });
      // The SPA's catch-all rewrites unknown paths to index.html, so a missing
      // `/api/*` behaviour still returns 200 — with HTML. Only a JSON reply
      // proves the behaviour is really forwarding to the API.
      if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) return "/api";
    } catch {
      // Network error, blocked request, anything: fall through to the absolute
      // URL, which is the shape that has always worked.
    }
    return BUILD_TIME_BASE;
  })();
  return probe;
}

/** Test seam: forget the probe so a new deployment shape can be exercised. */
export function resetApiBase(): void {
  probe = undefined;
}
