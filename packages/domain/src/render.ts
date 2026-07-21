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
      const href = `${block.url}#tok=${magicToken}`;
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

/** Matches an anchor, capturing (attrs-before-href)(href)(attrs-after-href)(inner). */
const ANCHOR_RE = /<a\b([^>]*?)\shref="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi;

/** Drop any existing fragment so we can append the per-recipient `#tok=…`. */
function baseUrl(u: string): string {
  const i = u.indexOf("#");
  return i >= 0 ? u.slice(0, i) : u;
}
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** Generic (per-campaign) link map for an HTML body — editorial anchors in order. */
export function buildHtmlLinkMap(html: string): EmailArchive["linkMap"] {
  const map: EmailArchive["linkMap"] = {};
  let li = 0;
  let position = 0;
  for (const m of html.matchAll(ANCHOR_RE)) {
    position++;
    map[`l${li}`] = {
      urlTemplate: baseUrl(m[2] ?? ""),
      position,
      label: stripTags(m[4] ?? ""),
      class: "editorial",
    };
    li++;
  }
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
  let li = 0;
  return merged.replace(ANCHOR_RE, (_full, pre: string, href: string, post: string, inner: string) => {
    const linkId = `l${li++}`;
    const target = `${baseUrl(href)}#tok=${magicToken}`;
    return `<a${pre} data-linkid="${linkId}" href="${escapeHtml(target)}"${post}>${inner}</a>`;
  });
}
