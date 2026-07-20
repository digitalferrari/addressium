/**
 * Feed parsing + edition assembly (docs/ARCHITECTURE.md §4.14, §4.16, #11).
 *
 * Pure, dependency-free parsing of RSS / Atom / JSON Feed into a normalized
 * FeedItem, field→merge-tag mapping, and assembly of a fresh newsletter edition
 * (editorial blocks + subject) from the latest items. The network fetch (with
 * the SSRF guard, IP pinning, timeouts and size caps) lives in the feeds
 * service; everything here runs on a string so it's fully unit-testable.
 */
import type { Block, EmailTemplate } from "./render.js";
import type { SendDescriptor } from "./ports.js";

export type FeedFormat = "rss" | "atom" | "json";

export interface FeedItem {
  title?: string;
  link?: string;
  content?: string;
  published?: string;
  id?: string;
  [field: string]: string | undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1] ?? "") : undefined;
}

function blocksBetween(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? "");
  return out;
}

function parseRss(xml: string): FeedItem[] {
  return blocksBetween(xml, "item").map((item) => ({
    title: tag(item, "title"),
    link: tag(item, "link"),
    content: tag(item, "description") ?? tag(item, "content:encoded"),
    published: tag(item, "pubDate"),
    id: tag(item, "guid") ?? tag(item, "link"),
  }));
}

function parseAtom(xml: string): FeedItem[] {
  return blocksBetween(xml, "entry").map((entry) => {
    // Atom link is an attribute: <link href="..."/>
    const href = entry.match(/<link[^>]*\shref=["']([^"']+)["']/i);
    return {
      title: tag(entry, "title"),
      link: href ? decodeEntities(href[1] ?? "") : undefined,
      content: tag(entry, "summary") ?? tag(entry, "content"),
      published: tag(entry, "updated") ?? tag(entry, "published"),
      id: tag(entry, "id"),
    };
  });
}

function parseJsonFeed(body: string): FeedItem[] {
  const doc = JSON.parse(body) as { items?: Array<Record<string, unknown>> };
  const items = doc.items ?? [];
  return items.map((it) => ({
    title: typeof it["title"] === "string" ? (it["title"] as string) : undefined,
    link: typeof it["url"] === "string" ? (it["url"] as string) : undefined,
    content:
      typeof it["content_html"] === "string"
        ? (it["content_html"] as string)
        : typeof it["content_text"] === "string"
          ? (it["content_text"] as string)
          : undefined,
    published: typeof it["date_published"] === "string" ? (it["date_published"] as string) : undefined,
    id: typeof it["id"] === "string" ? (it["id"] as string) : undefined,
  }));
}

export function parseFeed(body: string, format: FeedFormat): FeedItem[] {
  switch (format) {
    case "rss":
      return parseRss(body);
    case "atom":
      return parseAtom(body);
    case "json":
      return parseJsonFeed(body);
  }
}

/** Map a feed item's fields onto merge-tag names per the feed's fieldMap. */
export function mapFeedItem(item: FeedItem, fieldMap: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, tagName] of Object.entries(fieldMap)) {
    const value = item[field];
    if (value !== undefined) out[tagName] = value;
  }
  return out;
}

export interface EditionPlan {
  editionId: string;
  subject: string;
  template: EmailTemplate;
}

/**
 * Assemble a fresh edition from the latest feed items: the lead item's title
 * becomes the subject, and up to `maxItems` items become editorial blocks (only
 * items with both a title and a link). `editionKey` (e.g. the firing date)
 * makes the edition id stable and idempotent for that firing.
 */
export function buildEdition(
  items: FeedItem[],
  opts: { baseCampaignId: string; editionKey: string; maxItems?: number; subjectPrefix?: string },
): EditionPlan {
  const usable = items.filter((i) => i.title && i.link);
  const chosen = usable.slice(0, opts.maxItems ?? 10);
  const lead = chosen[0]?.title ?? "Your newsletter";
  const subject = opts.subjectPrefix ? `${opts.subjectPrefix}${lead}` : lead;
  const blocks: Block[] = chosen.map((i) => ({
    kind: "editorial",
    label: i.title!,
    url: i.link!,
  }));
  return {
    editionId: `${opts.baseCampaignId}-${opts.editionKey}`,
    subject,
    template: { blocks },
  };
}

/** What EventBridge Scheduler delivers to the automations launch handler. */
export interface RecurringLaunchPayload {
  /** Base descriptor: list, fallback subject/template, and the campaign-id stem. */
  descriptor: SendDescriptor;
  /** Optional feed the edition is built from on each firing. */
  feed?: { url: string; format: FeedFormat; fieldMap?: Record<string, string> };
  /** Stable per-firing key (e.g. the scheduled date) → idempotent edition id. */
  editionKey: string;
}

/**
 * Resolve the concrete SendDescriptor to enqueue for one recurring firing. With
 * feed items, the edition (subject + editorial blocks) is built from them; with
 * no feed, the base descriptor is reused with a fresh, editionKey-stamped id so
 * each firing is a distinct, idempotent send.
 */
export function planLaunchDescriptor(
  payload: RecurringLaunchPayload,
  items?: FeedItem[],
): SendDescriptor {
  if (payload.feed && items) {
    const edition = buildEdition(items, {
      baseCampaignId: payload.descriptor.campaignId,
      editionKey: payload.editionKey,
    });
    return {
      ...payload.descriptor,
      campaignId: edition.editionId,
      subject: edition.subject,
      template: edition.template,
    };
  }
  return {
    ...payload.descriptor,
    campaignId: `${payload.descriptor.campaignId}-${payload.editionKey}`,
  };
}
