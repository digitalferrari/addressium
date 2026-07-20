/**
 * addressium service: feeds
 * RSS/Atom/JSON pull -> merge-tag mapping
 *
 * See docs/ARCHITECTURE.md §4.14 and docs/SECURITY.md §4.5. This is a scaffold
 * stub — the SSRF guard is real and MUST wrap every outbound fetch.
 */
import { assertPublicHttpsUrl } from "./guard.js";

export interface HandlerEvent {
  feedUrl?: string;
  [key: string]: unknown;
}

export async function handler(event: HandlerEvent): Promise<unknown> {
  if (event.feedUrl) {
    // SSRF guard before any fetch (docs/SECURITY.md §4.5).
    const target = await assertPublicHttpsUrl(event.feedUrl);
    // TODO: fetch target.pinnedAddress with Host: target.url.host, tight
    // timeouts and size caps; parse RSS/Atom/JSON; map fields -> merge tags.
    return { ok: true, service: "feeds", pinned: target.pinnedAddress };
  }
  return { ok: true, service: "feeds", received: event };
}
