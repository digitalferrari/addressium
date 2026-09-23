/**
 * Minimal renderer for the slice. Production uses MJML/GrapesJS output; this
 * models the security-relevant behaviors we must get right:
 *  - merge-tag values are HTML-escaped (no markup injection via attributes),
 *  - editorial links get the per-recipient magic-link token in the FRAGMENT
 *    when the org has magic links on, and are otherwise rendered untouched —
 *    link-ids and the link map are identical either way, so click tracking
 *    does not depend on the feature,
 *  - ad slots are inserted verbatim and never tokenized/tracked,
 *  - a stable link-id is assigned per editorial link for the click map.
 */
import type { AdSlotFill, EmailArchive } from "@addressium/core";

export type Block =
  | { kind: "text"; html: string } // may contain {{merge}} placeholders
  | { kind: "editorial"; label: string; url: string }
  | { kind: "ad"; slot: string; html: string };

export interface EmailTemplate {
  /** Structured block body (the visual/slice model). Mutually exclusive with `html`. */
  blocks?: Block[];
  /**
   * Raw HTML body (raw_html mode, or MJML compiled to HTML later). When present,
   * the HTML render pipeline is used instead of the block renderer: merge tags
   * are escaped-substituted, `<a>` links are tokenized + given a link-id for the
   * click map. Mutually exclusive with `blocks`.
   */
  html?: string;
}

/**
 * Overlay the fills configured on a recurring series onto its structured
 * template. The authored block remains the fallback when a slot has no series
 * fill, which keeps campaign-level creative usable while a series is only
 * partially configured. The input is copied; stored templates are shared by
 * retries and must not be mutated by one send.
 *
 * Raw HTML/MJML uses the documented `{{slot_name}}` marker. Only slots that
 * have a series fill are replaced; the normal merge pass later clears any
 * remaining unresolved marker, matching the existing behavior for unknown
 * merge tags. Ad HTML is inserted before merge escaping so it remains markup.
 */
export function applySeriesAdFills(
  template: EmailTemplate,
  fills: readonly AdSlotFill[],
): EmailTemplate {
  const bySlot = new Map(fills.map((fill) => [fill.slot, fill.html]));
  if (template.html != null) {
    let html = template.html;
    for (const [slot, fill] of bySlot) {
      // Slot ids are validated at the API boundary, but escape them anyway so
      // this helper remains safe when called with a store fixture directly.
      const escaped = slot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Wrapped opaque (#313): advertiser markup is third-party and must not be
      // rewritten. Without this the per-recipient magic-link token was appended
      // to every ad anchor and handed to the ad server, and ad clicks were
      // counted as editorial engagement in the click map. The block path has
      // always been safe — an `ad` block renders verbatim and is never mapped —
      // and this gives raw HTML the same guarantee.
      html = html.replace(new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, "g"), () => opaque(fill));
    }
    return { ...template, html };
  }
  if (!template.blocks || fills.length === 0) return template;
  return {
    ...template,
    blocks: template.blocks.map((block) =>
      block.kind === "ad" && bySlot.has(block.slot)
        ? { ...block, html: bySlot.get(block.slot)! }
        : block,
    ),
  };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyMerge(html: string, attrs: Record<string, string>): string {
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) =>
    escapeHtml(attrs[key] ?? ""),
  );
}

/** Deterministic link-map for the archive (same for every recipient). */
export function buildLinkMap(t: EmailTemplate): EmailArchive["linkMap"] {
  if (t.html != null) return buildHtmlLinkMap(t.html);
  const map: EmailArchive["linkMap"] = {};
  let position = 0;
  let li = 0;
  for (const block of t.blocks ?? []) {
    position++;
    if (block.kind === "editorial") {
      map[`l${li}`] = {
        // Fragment-less, exactly like buildHtmlLinkMap below. A click arrives
        // fragment-redacted (events.ts), so storing an author-written fragment
        // here meant a click on that link never resolved to its link-id.
        urlTemplate: baseUrl(block.url),
        position,
        label: block.label,
        class: "editorial",
      };
      li++;
    }
  }
  return map;
}

/**
 * Render the body for one recipient, embedding their magic-link token.
 *
 * `magicToken` is positional and explicitly `| undefined` (not optional) so
 * every call site has to state which it means: an org with magic links off — or
 * a recipient with no linked pool account — renders plain editorial links, and
 * a forgotten argument must not silently produce them for an org that has the
 * feature on.
 */
/**
 * The inbox preview line (#302), as a hidden element at the very top of the body.
 *
 * Mail clients show it beside the subject in the message list; nothing should
 * ever see it inside the opened email. The style set is the one that survives
 * Gmail, Outlook and Apple Mail together — `display:none` alone is stripped by
 * some clients, so the zero box dimensions and `opacity:0` are load-bearing
 * rather than belt-and-braces.
 *
 * The trailing run of `&zwnj;&nbsp;` is deliberate: without it clients pull the
 * first words of real body copy in after the preheader to fill the preview,
 * which is precisely the behaviour a preheader exists to prevent.
 *
 * Merge values apply — a preheader saying "Your ledger, {{first_name}}" is a
 * normal thing to want — and it is escaped, so it can never inject markup.
 */
export function preheaderHtml(previewText: string, attrs: Record<string, string>): string {
  const text = escapeHtml(applyMerge(previewText, attrs));
  if (text.trim() === "") return "";
  const filler = "&zwnj;&nbsp;".repeat(60);
  return (
    '<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;' +
    'max-height:0px;max-width:0px;opacity:0;overflow:hidden;">' +
    `${text}${filler}</div>`
  );
}

export function renderForRecipient(
  t: EmailTemplate,
  attrs: Record<string, string>,
  magicToken: string | undefined,
  previewText?: string,
): string {
  const preheader = previewText ? preheaderHtml(previewText, attrs) : "";
  if (t.html != null) {
    const body = renderHtmlForRecipient(t.html, attrs, magicToken);
    if (!preheader) return body;
    // After <body> when there is one, so the hidden div is inside the rendered
    // document rather than floating before <!DOCTYPE>. Clients that see it
    // outside the body element may not treat it as preview text at all.
    const m = body.match(/<body[^>]*>/i);
    return m
      ? body.replace(m[0], `${m[0]}${preheader}`)
      : `${preheader}${body}`;
  }
  const parts: string[] = [];
  if (preheader) parts.push(preheader);
  let li = 0;
  for (const block of t.blocks ?? []) {
    if (block.kind === "text") {
      parts.push(`<p>${applyMerge(block.html, attrs)}</p>`);
    } else if (block.kind === "editorial") {
      // Token rides in the fragment (client-side only) — docs/SECURITY.md §4.1.
      // With no token the url is emitted as-is; the `data-linkid` below and the
      // link map are unchanged, so the link is still tracked.
      const href =
        magicToken === undefined ? safeHref(block.url) : `${safeHref(block.url)}#tok=${magicToken}`;
      parts.push(
        `<a data-linkid="l${li}" href="${escapeHtml(href)}">${escapeHtml(block.label)}</a>`,
      );
      li++;
    } else {
      // Ad slot: operator/advertiser HTML, inserted verbatim, never tracked.
      parts.push(block.html);
    }
  }
  return parts.join("\n");
}

// ---- raw-HTML render pipeline (raw_html mode / compiled MJML) ----

/** Extract the href value from one `<a …>` open tag (a short, `>`-bounded string). Linear. */
function extractHref(openTag: string): string | undefined {
  const m = openTag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return m ? (m[1] ?? m[2] ?? "") : undefined;
}

/** Drop any existing fragment so we can append the per-recipient `#tok=…`. */
function baseUrl(u: string): string {
  const i = u.indexOf("#");
  return i >= 0 ? u.slice(0, i) : u;
}

/**
 * Neutralize dangerous link schemes at render (#94). Blocks-mode editorial urls
 * are schema-validated, but the `mjmlHtml` path bypasses the raw-HTML sanitizer,
 * so we re-check here: an absolute http(s)/mailto url, a protocol-relative/root/
 * fragment-relative url, or a scheme-less relative url is kept; anything with an
 * explicit disallowed scheme (`javascript:`/`data:`/`vbscript:`…) becomes "#".
 */
function safeHref(u: string): string {
  // Control characters are STRIPPED before the scheme is read (#201), not just
  // trimmed from the ends. Browsers discard C0 control characters and DEL
  // anywhere inside a URL before resolving it, so `java\tscript:alert(1)` loads
  // as `javascript:` — while the old check saw an interior tab, failed to match
  // the scheme pattern, concluded "no scheme ⇒ relative" and let it through.
  // Trimming alone cannot see that, because the character is in the middle.
  // eslint-disable-next-line no-control-regex
  const t = u.replace(/[\u0000-\u0020\u007f]/g, "");
  if (/^(https?:|mailto:|\/\/|\/|#)/i.test(t)) return u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) return u; // no scheme ⇒ relative, allowed
  return "#";
}

/**
 * Strip HTML tags to plain text in a single linear pass. A `/<[^>]*>/g` sanitizer
 * is both ReDoS-prone (quadratic on many `<`) and incomplete (tags can reform),
 * so we walk char-by-char instead. Used only for editorial link labels.
 */
function stripTags(s: string): string {
  let out = "";
  let inTag = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** True if the char after "<a" ends the tag name — distinguishes `<a …>` from `<article>`. */
function isAnchorBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "/" || ch === ">";
}

/**
 * Walk the HTML once with plain `indexOf` (no global regex over untrusted input —
 * avoids js/polynomial-redos), invoking `onText` for each run between anchors and
 * `onAnchor` for each `<a …>` open tag with its href and the index just past it.
 */
/**
 * Marks a span of THIRD-PARTY html that we pass through untouched (#313).
 *
 * Advertiser markup must not be rewritten. Before this, `renderHtmlForRecipient`
 * appended the per-recipient magic-link token to EVERY anchor it found —
 * including ones spliced in from an ad tag — so an org with magic links enabled
 * handed a subscriber credential to the ad server on every impression. Ad links
 * also landed in the click map classed "editorial", counting advertiser clicks
 * as editorial engagement.
 *
 * The block renderer never had this problem: an `ad` block is emitted verbatim
 * and `buildLinkMap` only maps `kind: "editorial"`. This gives the raw-HTML path
 * the same guarantee.
 *
 * Comment delimiters so the marker survives a round trip through an email
 * designer, and so an operator reading the source can see why a region is
 * exempt.
 */
export const OPAQUE_OPEN = "<!--addressium:opaque-->";
export const OPAQUE_CLOSE = "<!--/addressium:opaque-->";

/** Wrap third-party html so the anchor scanner passes over it. */
export function opaque(html: string): string {
  return `${OPAQUE_OPEN}${html}${OPAQUE_CLOSE}`;
}

/**
 * Walk the HTML once with plain `indexOf` (no global regex over untrusted input —
 * avoids js/polynomial-redos), invoking `onText` for each run between anchors and
 * `onAnchor` for each `<a …>` open tag with its href and the index just past it.
 *
 * Spans between the opaque markers are handed to `onText` whole: they are never
 * scanned for anchors, so nothing inside them is tokenized or link-mapped.
 */
function scanAnchors(
  html: string,
  onText: (text: string) => void,
  onAnchor: (openTag: string, href: string | undefined, innerStart: number) => void,
): void {
  const lower = html.toLowerCase();
  let i = 0;
  for (;;) {
    // An opaque region BEFORE the next anchor short-circuits the scan: emit it
    // verbatim and resume after it. Checked first so an anchor inside the
    // region can never be reached.
    const opaqueAt = lower.indexOf(OPAQUE_OPEN, i);
    const nextA = lower.indexOf("<a", i);
    if (opaqueAt >= 0 && (nextA < 0 || opaqueAt < nextA)) {
      const close = lower.indexOf(OPAQUE_CLOSE, opaqueAt);
      // An unclosed marker means the rest of the document is third-party. Fail
      // CLOSED: passing it through untouched loses tracking, whereas scanning
      // it would leak the token, which is the thing this exists to prevent.
      const end = close < 0 ? html.length : close + OPAQUE_CLOSE.length;
      onText(html.slice(i, end));
      if (close < 0) return;
      i = end;
      continue;
    }
    const lt = nextA;
    if (lt < 0) {
      onText(html.slice(i));
      return;
    }
    if (!isAnchorBoundary(lower[lt + 2])) {
      onText(html.slice(i, lt + 2)); // not an <a> tag (e.g. <article>)
      i = lt + 2;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt < 0) {
      onText(html.slice(i));
      return;
    }
    onText(html.slice(i, lt));
    const openTag = html.slice(lt, gt + 1);
    onAnchor(openTag, extractHref(openTag), gt + 1);
    i = gt + 1;
  }
}

/** Generic (per-campaign) link map for an HTML body — editorial anchors in order. */
export function buildHtmlLinkMap(html: string): EmailArchive["linkMap"] {
  const map: EmailArchive["linkMap"] = {};
  let li = 0;
  let position = 0;
  const lower = html.toLowerCase();
  scanAnchors(
    html,
    () => {},
    (_openTag, href, innerStart) => {
      if (href === undefined) return; // only editorial links (with an href) are mapped
      position++;
      const end = lower.indexOf("</a>", innerStart);
      const inner = end >= 0 ? html.slice(innerStart, end) : html.slice(innerStart);
      map[`l${li}`] = {
        urlTemplate: baseUrl(href),
        position,
        label: stripTags(inner),
        class: "editorial",
      };
      li++;
    },
  );
  return map;
}

/**
 * Render an HTML body for one recipient: escape-substitute merge tags, then
 * tokenize each `<a>` (per-recipient magic token in the fragment) and stamp a
 * stable `data-linkid` matching {@link buildHtmlLinkMap} for click tracking.
 *
 * With `magicToken` undefined (magic links off for the org, or no linked pool
 * account for this recipient) the href keeps any author-written fragment and
 * gains no token — but it is still rewritten through `safeHref` and still gets
 * its `data-linkid`, so neither the #94 scheme guard nor click tracking depends
 * on the feature being on.
 */
export function renderHtmlForRecipient(
  html: string,
  attrs: Record<string, string>,
  magicToken: string | undefined,
): string {
  const merged = applyMerge(html, attrs);
  let out = "";
  let li = 0;
  scanAnchors(
    merged,
    (text) => {
      out += text;
    },
    (openTag, href) => {
      if (href === undefined) {
        out += openTag; // leave non-link anchors untouched
        return;
      }
      const linkId = `l${li++}`;
      // Only strip an existing fragment when we're replacing it with the token;
      // with no token the author's fragment is theirs to keep. Click tracking is
      // unaffected either way — recordClick redacts everything from "#" on, and
      // buildHtmlLinkMap stores the fragment-less url.
      const target =
        magicToken === undefined ? safeHref(href) : `${safeHref(baseUrl(href))}#tok=${magicToken}`;
      // Replacer FUNCTIONS, not replacement strings: a replacement string expands
      // `$&`, `` $` ``, `$'` and `$$`, and escapeHtml does not escape `$`. A merge
      // value or URL containing `$&` would re-inject raw quotes — corrupting every
      // link and allowing attribute injection (e.g. onerror=) into the anchor.
      const retagged = openTag.replace(
        /\bhref\s*=\s*(?:"[^"]*"|'[^']*')/i,
        () => `href="${escapeHtml(target)}"`,
      );
      out += retagged.replace(/>$/, () => ` data-linkid="${linkId}">`);
    },
  );
  return out;
}

/**
 * A plain-text alternative for a rendered HTML body (#204, #200).
 *
 * `SentMessage.text` has existed since the port was written and NOTHING ever set
 * it on a campaign send, so every newsletter went out as HTML-only. That costs
 * real deliverability — a missing text part is a spam-score signal at every major
 * provider — and it is simply broken for the people who read mail as text.
 *
 * Derived from the rendered HTML rather than authored twice: two bodies drift,
 * and the one nobody looks at is the one that drifts. Links become
 * `label <url>` so a text reader can still reach them, which matters most for
 * the unsubscribe link.
 *
 * This is a converter for OUR OWN rendered output, not a general HTML-to-text
 * engine — it does not lay out tables or wrap columns. A template whose meaning
 * depends on a table layout has a poor text part, which is a property of the
 * template rather than a bug here.
 */
export function plainTextFrom(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      // Unterminated tag: the remainder is markup we cannot read, so drop it
      // rather than emitting a half-tag as if it were prose.
      break;
    }
    const tag = html.slice(lt, gt + 1);
    const name = /^<\s*\/?\s*([a-z0-9]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";

    if (name === "script" || name === "style") {
      // Skip the element's CONTENT too — CSS and JS are not text alternatives.
      const close = html.toLowerCase().indexOf(`</${name}`, gt);
      i = close === -1 ? html.length : (html.indexOf(">", close) + 1 || html.length);
      continue;
    }
    if (name === "a" && !tag.startsWith("</")) {
      const href = extractHref(tag);
      const close = html.toLowerCase().indexOf("</a", gt);
      const label = stripTags(html.slice(gt + 1, close === -1 ? html.length : close)).trim();
      // A url identical to its label reads as a stutter — "https://x <https://x>".
      out += href && href !== label && href !== "#" ? `${label} <${href}>` : label;
      i = close === -1 ? html.length : (html.indexOf(">", close) + 1 || html.length);
      continue;
    }
    if (["p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "table"].includes(name)) {
      out += "\n";
    }
    i = gt + 1;
  }
  return (
    decodeEntities(out)
      // Collapse the runs of blank lines that block-level tags leave behind,
      // without collapsing a deliberate paragraph break to nothing.
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Reverse `escapeHtml` for the text part.
 *
 * `&amp;` LAST, and that ordering is the whole point: decoding it first would
 * turn `&amp;lt;` — the correct escaping of the literal text `&lt;` — into `<`,
 * re-introducing markup into the part that is supposed to have none.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
