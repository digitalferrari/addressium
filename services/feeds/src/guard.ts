/**
 * SSRF egress guard — re-exported from the domain, where the pure logic now
 * lives (docs/SECURITY.md §4.5). Kept here for import stability of the feeds
 * service surface.
 */
export {
  assertPublicHttpsUrl,
  SsrfBlockedError,
  type SafeTarget,
} from "@addressium/domain";
