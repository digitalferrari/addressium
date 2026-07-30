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
 * Record a DELIVERY (#210).
 *
 * SES has published `Delivery` since the event destination went in (#208) — the
 * config set subscribes to it — but nothing consumed it, so `HotCounters.delivered`
 * never moved off zero. Every delivery rate in the product therefore read 0%,
 * and the bounce rate it is compared against was computed over a denominator
 * that did not exist. A reporting number that is always wrong is worse than an
 * absent one, because a dashboard shows it without comment.
 *
 * Idempotent through `eventId` like every other event: SNS is at-least-once, and
 * a redelivered notification must not inflate the count it is supposed to fix.
 */
/**
 * Record the three SES outcomes that used to be dropped on the floor (#241).
 *
 * All three were in SES's feed the whole time and none was in the `ACTIONABLE`
 * map, so `normalize` resolved them to `undefined` and the handler acknowledged
 * them as unresolvable. What each one costs, and why none of them is a bounce:
 *
 *  - **`reject`** — SES accepted the message and then refused to send it (a virus,
 *    blocked content). Nothing was delivered and no RECEIVER rejected anything, so
 *    suppressing the address would punish a subscriber for our attachment. Counted
 *    apart from both `delivered` and `bounces`, because folded into either one the
 *    number it joins becomes a lie.
 *  - **`rendering_failure`** — a merge tag did not resolve, so SES could not build
 *    the message at all. This is the one event in the feed that points at OUR bug
 *    rather than a recipient's mailbox, which is why the handler logs it at error
 *    level and an alarm watches for it: a template broken for one recipient is
 *    broken for the whole campaign, and the count alone would sit in a dashboard
 *    nobody opens until the send is over.
 *  - **`delivery_delay`** — a full mailbox or a throttling receiver, still being
 *    retried. It MUST NOT suppress: most delays resolve, and suppressing on one
 *    would kill a valid subscriber globally for a condition that clears. Exactly
 *    the reasoning behind the transient-bounce gate (#211), which is why these
 *    three go through their own recorder rather than anywhere near `recordBounce`.
 *
 * Idempotent through `eventId` like every other event.
 */
export async function recordSendOutcome(
  stores: Stores,
  clock: Clock,
  input: {
    orgId: string;
    campaignId: string;
    subscriberId: string;
    type: Extract<EngagementEvent["type"], "reject" | "rendering_failure" | "delivery_delay">;
    eventId?: string;
  },
): Promise<void> {
  await stores.events.append({
    orgId: input.orgId,
    campaignId: input.campaignId,
    subscriberId: input.subscriberId,
    type: input.type,
    at: clock.now().toISOString(),
    eventId: input.eventId,
  });
}

export async function recordDelivered(
  stores: Stores,
  clock: Clock,
  orgId: string,
  campaignId: string,
  subscriberId: string,
  eventId?: string,
): Promise<void> {
  await stores.events.append({
    orgId,
    campaignId,
    subscriberId,
    type: "delivered",
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
/**
 * Split a URL template on its `{{tag}}` tokens, in linear time.
 *
 * This used to be `urlTemplate.split(/\{\{[^}]*\}\}/)` — and the comment below
 * about avoiding backtracking was right about the MATCHING and wrong about the
 * TOKENISING it depended on. `[^}]*` cannot cross a `}`, so on a run of `{`
 * with no closing `}}` the engine consumes to the end, fails, and retries from
 * the next index: O(n²), measured at 134ms for 12.5k characters and 8.7s for
 * 100k — a clean 4× per doubling (CodeQL #29).
 *
 * Reachable because `urlTemplate` comes from the campaign's archived link map,
 * which is built from an operator-authored template, and `matchesUrlTemplate` is
 * called once per link per CLICK event. A template carrying one pathological URL
 * would make every click on that campaign quadratic inside the events Lambda.
 *
 * The scan below is exactly equivalent to that regex — including the rule that a
 * tag body may not contain `}`, so `{{a}b}}` is literal text, not a tag — and it
 * is linear because it never rescans a prefix it has already rejected.
 */
function splitOnMergeTags(s: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i + 1 < s.length) {
    if (s[i] !== "{" || s[i + 1] !== "{") {
      i++;
      continue;
    }
    // The regex's `[^}]*` is greedy but cannot cross a `}`, so the only
    // candidate close is the FIRST `}` after the opener. Nothing to backtrack.
    let j = i + 2;
    while (j < s.length && s[j] !== "}") j++;
    if (j + 1 < s.length && s[j] === "}" && s[j + 1] === "}") {
      parts.push(s.slice(start, i));
      i = j + 2;
      start = i;
      continue;
    }
    // No tag closes here. Every position in [i, j-2] would scan to this same
    // `j` and fail identically, and neither `j-1` nor `j` can BE an opener —
    // both would need `s[j]` to be `{`, and it is `}` or the end of the string.
    // So the next position worth trying is `j + 1`, and skipping the whole
    // scanned run is what keeps this linear. Resuming at `i + 1` instead is
    // precisely the O(n²) the regex had.
    i = j + 1;
  }
  parts.push(s.slice(start));
  return parts;
}

export function matchesUrlTemplate(urlTemplate: string, url: string): boolean {
  // Fast path, and the only path for the common case of a link with no tags.
  if (urlTemplate === url) return true;
  const parts = splitOnMergeTags(urlTemplate);
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
  /**
   * The campaign's events, when the caller has already read them (#182).
   *
   * `buildCampaignReport` read the whole log and then called this, which read it
   * AGAIN — two full reads of an unbounded item set to render one screen. Passed
   * in rather than cached inside, so there is no hidden lifetime to reason about
   * and a direct caller still gets a correct answer.
   */
  preloaded?: EngagementEvent[],
): Promise<ClickMap> {
  const archive = await stores.archive.get(orgId, campaignId);
  const events = preloaded ?? (await stores.events.all(orgId, campaignId));
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
