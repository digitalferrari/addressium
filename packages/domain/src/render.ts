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
  blocks: Block[];
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
  const map: EmailArchive["linkMap"] = {};
  let position = 0;
  let li = 0;
  for (const block of t.blocks) {
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
  const parts: string[] = [];
  let li = 0;
  for (const block of t.blocks) {
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
