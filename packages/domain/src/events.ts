/**
 * Events processing + click map (docs/ARCHITECTURE.md §4.5, §4.8).
 *
 * The click handler is where token REDACTION happens: SES reports the full
 * destination URL of an editorial link (token in the fragment), and we must
 * strip the token before anything is persisted (docs/SECURITY.md §4.7).
 */
import type { EngagementEvent } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

export interface RecordClickInput {
  /** Stable source id so a redelivered notification doesn't double-count (#183). */
  eventId?: string;
  orgId: string;
  campaignId: string;
  subscriberId: string;
  /** Full clicked URL as reported by SES — may carry the token in the fragment. */
  clickedUrl: string;
}

/** Strip the token so it never lands at rest. Returns the bare URL (no fragment). */
export function redactToken(clickedUrl: string): string {
  const hash = clickedUrl.indexOf("#");
  return hash === -1 ? clickedUrl : clickedUrl.slice(0, hash);
}

export async function recordOpen(
  stores: Stores,
  clock: Clock,
  orgId: string,
  campaignId: string,
  subscriberId: string,
  /** Stable source id so a redelivered notification doesn't double-count (#183). */
  eventId?: string,
): Promise<void> {
  await stores.events.append({
    orgId,
    campaignId,
    subscriberId,
    type: "open",
    at: clock.now().toISOString(),
    eventId,
  });
}

/**
 * Does a clicked URL correspond to this link's template? (#201)
 *
 * `urlTemplate` is stored UNRENDERED — `https://x.com/a?u={{email}}` — while the
 * recipient clicks the RENDERED url, `https://x.com/a?u=reader%40x.com`. Exact
 * equality can never match those, so every click on a link containing a merge
 * tag resolved to no link-id at all: the click was recorded, the campaign's
 * click COUNT was right, and the click MAP showed zero for that link. Silent,
 * and worst on exactly the personalised links an operator most wants to measure.
 *
 * Matched by splitting on the tags and walking the literal parts in order rather
 * than building a regex. `{{a}}.*{{b}}.*` style patterns backtrack, and this
 * repo has a ReDoS regression suite precisely because that has bitten before —
 * a scan is linear and cannot.
 */
export function matchesUrlTemplate(urlTemplate: string, url: string): boolean {
  // Fast path, and the only path for the common case of a link with no tags.
  if (urlTemplate === url) return true;
  const parts = urlTemplate.split(/\{\{[^}]*\}\}/);
  if (parts.length === 1) return false; // no merge tags: equality was the answer

  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (!url.startsWith(first)) return false;
  if (!url.endsWith(last)) return false;
  // The ends must not overlap, or `a{{x}}a` would match a bare "a".
  if (first.length + last.length > url.length) return false;

  // Interior literals must appear in order, after the prefix and before the
  // suffix. A tag matches anything, including empty.
  let at = first.length;
  const limit = url.length - last.length;
  for (const part of parts.slice(1, -1)) {
    if (part === "") continue;
    const found = url.indexOf(part, at);
    if (found < 0 || found + part.length > limit) return false;
    at = found + part.length;
  }
  return true;
}

/** Records a click, resolving the redacted URL to its stable link-id. */
export async function recordClick(
  stores: Stores,
  clock: Clock,
  input: RecordClickInput,
): Promise<string | undefined> {
  const bareUrl = redactToken(input.clickedUrl);
  const archive = await stores.archive.get(input.orgId, input.campaignId);
  let linkId: string | undefined;
  if (archive) {
    const entries = Object.entries(archive.linkMap);
    // Exact matches win outright. A campaign can carry both a literal link and a
    // templated one that happens to subsume it, and the literal is the better
    // answer — resolving by template order alone would attribute the click to
    // whichever happened to be enumerated first.
    const exact = entries.find(([, e]) => e.urlTemplate === bareUrl);
    const hit = exact ?? entries.find(([, e]) => matchesUrlTemplate(e.urlTemplate, bareUrl));
    linkId = hit?.[0];
  }
  const evt: EngagementEvent = {
    orgId: input.orgId,
    subscriberId: input.subscriberId,
    campaignId: input.campaignId,
    type: "click",
    linkId, // token is NOT stored — only the resolved link-id
    at: clock.now().toISOString(),
    eventId: input.eventId,
  };
  await stores.events.append(evt);
  // Clicks are the engagement signal that resets the sunset clock (opens are not
  // counted — they're auto-fired by privacy proxies). Monotonic, best-effort.
  await stores.subscribers.markEngaged(input.orgId, input.subscriberId, evt.at);
  return linkId;
}

export interface ClickMapRow {
  linkId: string;
  label: string;
  urlTemplate: string;
  clicks: number;
  unique: number;
}
export interface ClickMap {
  sent: number;
  rows: ClickMapRow[];
}

export async function buildClickMap(
  stores: Stores,
  orgId: string,
  campaignId: string,
): Promise<ClickMap> {
  const archive = await stores.archive.get(orgId, campaignId);
  const events = await stores.events.all(orgId, campaignId);
  const sent = events.filter((e) => e.type === "sent").length;
  const rows: ClickMapRow[] = [];

  if (archive) {
    for (const [linkId, entry] of Object.entries(archive.linkMap)) {
      const clicks = events.filter((e) => e.type === "click" && e.linkId === linkId);
      const unique = new Set(clicks.map((e) => e.subscriberId)).size;
      rows.push({
        linkId,
        label: entry.label,
        urlTemplate: entry.urlTemplate,
        clicks: clicks.length,
        unique,
      });
    }
  }
  rows.sort((a, b) => b.clicks - a.clicks);
  return { sent, rows };
}
