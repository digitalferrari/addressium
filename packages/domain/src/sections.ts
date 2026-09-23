/**
 * Region-based template assembly (#299, #300).
 *
 * The composition model these newsletters actually use: an operator designs a
 * whole HTML email — masthead, sponsor banner, section headings, footer — and
 * marks the places where feed stories go. Each firing expands those regions
 * from the current feed and leaves everything else untouched.
 *
 * This is the inverse of `buildEdition`, which constructs a body out of feed
 * items and discards whatever the operator composed. That is right for a bare
 * list of links and wrong for a designed publication, where the template IS the
 * product and the feed only supplies its contents.
 *
 * A region is delimited by HTML comments and repeated once per story:
 *
 *   <!-- START MAIN STORY -->   …{{HEADLINE}}…{{IMG}}…{{URL}}…   <!-- END MAIN STORY -->
 *
 * so the markup between them is a per-story template. Story 0 uses MAIN, the
 * rest use BODY — position, not category, picks the layout. Comment delimiters
 * rather than a custom syntax because they survive every WYSIWYG email editor:
 * an operator can open the template in their designer, move a region, and the
 * markers come back intact.
 */

export interface SectionStory {
  headline: string;
  url: string;
  image?: string;
  bodyText?: string;
}

/** Per-story placeholders, substituted inside a repeated region. */
const STORY_TOKENS = ["URL", "HEADLINE", "IMG", "BODYTEXT"] as const;

/**
 * One repeatable region of the template.
 *
 * `lead` is the larger layout used for the first story only; a section without
 * one (the AFTERMAIN category blocks) repeats `item` for every story.
 */
export interface Region {
  lead?: string;
  item: string;
  /** The whole span to replace, including its delimiters. */
  span: { start: number; end: number };
}

/** Escape a value being substituted into an HTML attribute or text node. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Find `<!-- START X -->…<!-- END X -->` (or BEGIN/END), tolerating the
 * whitespace variations real templates carry — `<!--- BEGIN X-->` appears in
 * the production template alongside the canonical spelling.
 */
export function findRegion(html: string, name: string): { inner: string; start: number; end: number } | undefined {
  const open = new RegExp(`<!--+\\s*(?:START|BEGIN)\\s+${name}\\s*-*->`, "i");
  const close = new RegExp(`<!--+\\s*END\\s+${name}\\s*-*->`, "i");
  const o = open.exec(html);
  if (!o) return undefined;
  const afterOpen = o.index + o[0].length;
  const c = close.exec(html.slice(afterOpen));
  if (!c) return undefined;
  return {
    inner: html.slice(afterOpen, afterOpen + c.index),
    start: o.index,
    end: afterOpen + c.index + c[0].length,
  };
}

/** Substitute one story's values into a region's per-story markup. */
export function renderStory(itemHtml: string, story: SectionStory): string {
  let out = itemHtml;
  for (const token of STORY_TOKENS) {
    const value =
      token === "URL" ? story.url
      : token === "HEADLINE" ? story.headline
      : token === "IMG" ? (story.image ?? "")
      : (story.bodyText ?? "");
    // Global, because {{URL}} appears several times in one story region — the
    // image link, the headline link and the Read More button all point at it.
    out = out.split(`{{${token}}}`).join(escapeHtml(value));
  }
  return out;
}

export interface ExpandOptions {
  /**
   * Ad HTML interleaved one after each story, in order, until exhausted (#300).
   *
   * Deliberately not "every N stories" or a position list: one ad follows each
   * story and the surplus on either side is dropped. A publication carries 3-9
   * body ads against 6-8 stories, so BOTH more-ads-than-stories and
   * more-stories-than-ads are ordinary, not edge cases.
   */
  ads?: string[];
  /** Wrapper around each ad; `{{ADPLACEMENT}}` is where the tag goes. */
  adWrapper?: string;
  /** Cap on stories rendered, for the smaller category sections. */
  maxItems?: number;
}

/**
 * Expand one region: repeat its markup per story, interleaving ads.
 *
 * Returns the replacement HTML for the whole delimited span. The caller splices
 * it back so the surrounding template is preserved byte for byte.
 */
export function expandRegion(
  region: { lead?: string; item: string },
  stories: SectionStory[],
  opts: ExpandOptions = {},
): string {
  const chosen = opts.maxItems === undefined ? stories : stories.slice(0, opts.maxItems);
  const ads = opts.ads ?? [];
  const parts: string[] = [];
  chosen.forEach((story, i) => {
    const markup = i === 0 && region.lead !== undefined ? region.lead : region.item;
    parts.push(renderStory(markup, story));
    // One ad after each story, in order, while any remain. No wrap-around and
    // no reuse: an ad is a sold placement, not a decoration to repeat.
    const ad = ads[i];
    if (ad !== undefined) {
      parts.push(opts.adWrapper ? opts.adWrapper.split("{{ADPLACEMENT}}").join(ad) : ad);
    }
  });
  return parts.join("\n");
}
