/**
 * addressium service: feeds — SSRF-guarded fetch + RSS/Atom/JSON parse → merge tags.
 *
 * See docs/ARCHITECTURE.md §4.14 and docs/SECURITY.md §4.5. Every outbound fetch
 * goes through the SSRF guard, connects to the PINNED public IP (defeating DNS
 * rebinding) with the original Host header + SNI, and is bounded by a tight
 * timeout and a response size cap. The parsed items are mapped to merge tags.
 */
import { request } from "node:https";
import { parseFeed, mapFeedItem, type FeedFormat, type FeedItem } from "@addressium/domain";
import { assertPublicHttpsUrl, type SafeTarget } from "./guard.js";

export { assertPublicHttpsUrl, SsrfBlockedError } from "./guard.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/** Fetch the pinned IP with the real Host/SNI, bounded by timeout + size cap. */
export function fetchPinned(target: SafeTarget, opts: FetchOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.pinnedAddress, // connect to the pinned public IP
        servername: target.url.hostname, // SNI + cert validation for the real host
        path: `${target.url.pathname}${target.url.search}`,
        method: "GET",
        // rejectUnauthorized defaults true — TLS is validated against servername.
        headers: {
          Host: target.url.host,
          "user-agent": "addressium-feeds/1",
          accept: "application/rss+xml, application/atom+xml, application/json, text/xml",
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Do NOT follow redirects — a 3xx could point at an internal address.
        if (status >= 300) {
          res.destroy();
          reject(new Error(`feed returned status ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new Error("feed exceeded size cap"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("timeout", () => req.destroy(new Error("feed fetch timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** Full pipeline: guard → pinned fetch → parse. */
export async function fetchFeedItems(
  feedUrl: string,
  format: FeedFormat,
  opts: FetchOptions = {},
): Promise<FeedItem[]> {
  const target = await assertPublicHttpsUrl(feedUrl);
  const body = await fetchPinned(target, opts);
  return parseFeed(body, format);
}

export interface HandlerEvent {
  feedUrl?: string;
  format?: FeedFormat;
  fieldMap?: Record<string, string>;
  [key: string]: unknown;
}

export async function handler(event: HandlerEvent): Promise<unknown> {
  if (!event.feedUrl) return { ok: true, service: "feeds", received: event };
  const items = await fetchFeedItems(event.feedUrl, event.format ?? "rss", {});
  const mapped = event.fieldMap ? items.map((i) => mapFeedItem(i, event.fieldMap!)) : items;
  return { ok: true, service: "feeds", count: items.length, items: mapped };
}
