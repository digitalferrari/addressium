/**
 * Minimal renderer for the slice. Production uses MJML/GrapesJS output; this
 * models the security-relevant behaviors we must get right:
 *  - merge-tag values are HTML-escaped (no markup injection via attributes),
 *  - editorial links get the per-recipient magic-link token in the FRAGMENT,
 *  - ad slots are inserted verbatim and never tokenized/tracked,
 *  - a stable link-id is assigned per editorial link for the click map.
 */
import type { EmailArchive } from "@addressium/core";

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
        urlTemplate: block.url,
        position,
        label: block.label,
        class: "editorial",
      };
      li++;
    }
  }
  return map;
}

/** Render the body for one recipient, embedding their magic-link token. */
export function renderForRecipient(
  t: EmailTemplate,
  attrs: Record<string, string>,
  magicToken: string,
): string {
  if (t.html != null) return renderHtmlForRecipient(t.html, attrs, magicToken);
  const parts: string[] = [];
  let li = 0;
  for (const block of t.blocks ?? []) {
    if (block.kind === "text") {
      parts.push(`<p>${applyMerge(block.html, attrs)}</p>`);
    } else if (block.kind === "editorial") {
      // Token rides in the fragment (client-side only) — docs/SECURITY.md §4.1.
      const href = `${safeHref(block.url)}#tok=${magicToken}`;
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
  const t = u.trim();
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
function scanAnchors(
  html: string,
  onText: (text: string) => void,
  onAnchor: (openTag: string, href: string | undefined, innerStart: number) => void,
): void {
  const lower = html.toLowerCase();
  let i = 0;
  for (;;) {
    const lt = lower.indexOf("<a", i);
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
 */
export function renderHtmlForRecipient(
  html: string,
  attrs: Record<string, string>,
  magicToken: string,
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
      const target = `${safeHref(baseUrl(href))}#tok=${magicToken}`;
      const retagged = openTag.replace(/\bhref\s*=\s*(?:"[^"]*"|'[^']*')/i, `href="${escapeHtml(target)}"`);
      out += retagged.replace(/>$/, ` data-linkid="${linkId}">`);
    },
  );
  return out;
}
