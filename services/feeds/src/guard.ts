/**
 * SSRF egress guard for outbound feed fetches (docs/SECURITY.md §4.5).
 *
 * The feeds feature fetches operator-supplied URLs server-side, which is a
 * textbook SSRF sink. This guard enforces: HTTPS-only, and that the resolved IP
 * is public (blocking link-local, loopback and private ranges — including the
 * cloud metadata address). Callers MUST fetch the pinned IP returned here, not
 * re-resolve the hostname, to defeat DNS rebinding.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_V4: RegExp[] = [
  /^0\./, // "this" network
  /^10\./, // private
  /^127\./, // loopback
  /^169\.254\./, // link-local (incl. 169.254.169.254 metadata)
  /^172\.(1[6-9]|2\d|3[01])\./, // private 172.16/12
  /^192\.168\./, // private
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
];

function isBlockedAddress(addr: string): boolean {
  if (addr === "::1" || addr.startsWith("fc") || addr.startsWith("fd") || addr.startsWith("fe80")) {
    return true; // IPv6 loopback / ULA / link-local
  }
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return BLOCKED_V4.some((re) => re.test(v4));
}

export interface SafeTarget {
  url: URL;
  /** Resolved public IP — fetch THIS to avoid DNS rebinding. */
  pinnedAddress: string;
}

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Throws SsrfBlockedError unless `raw` is an https URL resolving to a public IP. */
export async function assertPublicHttpsUrl(raw: string): Promise<SafeTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError("invalid URL");
  }
  if (url.protocol !== "https:") {
    throw new SsrfBlockedError("feeds must use https");
  }

  const host = url.hostname;
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true });

  if (addresses.length === 0) {
    throw new SsrfBlockedError("host did not resolve");
  }
  for (const a of addresses) {
    if (isBlockedAddress(a.address)) {
      throw new SsrfBlockedError(`blocked non-public address for ${host}`);
    }
  }
  return { url, pinnedAddress: addresses[0]!.address };
}
