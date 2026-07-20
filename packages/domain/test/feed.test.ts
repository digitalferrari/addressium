/**
 * Feed parsing (RSS/Atom/JSON), field→merge-tag mapping, and edition assembly:
 * the lead item's title becomes the subject and items become editorial blocks;
 * the launch planner stamps an editionKey-idempotent campaign id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFeed,
  mapFeedItem,
  buildEdition,
  planLaunchDescriptor,
  type EmailTemplate,
  type RecurringLaunchPayload,
} from "@addressium/domain";

const RSS = `<?xml version="1.0"?><rss><channel>
  <item><title>Markets rally</title><link>https://northwindtimes.example/a</link><description><![CDATA[Stocks up]]></description><guid>g1</guid></item>
  <item><title>Snow &amp; sun</title><link>https://northwindtimes.example/b</link><description>Weather</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed>
  <entry><title>Atom one</title><link href="https://x.com/1"/><summary>s1</summary><id>id1</id></entry>
</feed>`;

const JSONF = JSON.stringify({
  items: [{ title: "JSON one", url: "https://x.com/j1", content_text: "hello", id: "j1" }],
});

test("parseFeed reads RSS items with CDATA + entity decoding", () => {
  const items = parseFeed(RSS, "rss");
  assert.equal(items.length, 2);
  assert.equal(items[0]?.title, "Markets rally");
  assert.equal(items[0]?.link, "https://northwindtimes.example/a");
  assert.equal(items[0]?.content, "Stocks up");
  assert.equal(items[1]?.title, "Snow & sun"); // &amp; decoded
});

test("parseFeed reads Atom entries (href link attribute) and JSON Feed", () => {
  const atom = parseFeed(ATOM, "atom");
  assert.equal(atom[0]?.title, "Atom one");
  assert.equal(atom[0]?.link, "https://x.com/1");

  const json = parseFeed(JSONF, "json");
  assert.equal(json[0]?.title, "JSON one");
  assert.equal(json[0]?.link, "https://x.com/j1");
  assert.equal(json[0]?.content, "hello");
});

test("mapFeedItem maps declared feed fields onto merge-tag names", () => {
  const [item] = parseFeed(RSS, "rss");
  const mapped = mapFeedItem(item!, { title: "lead_headline", link: "lead_url" });
  assert.deepEqual(mapped, { lead_headline: "Markets rally", lead_url: "https://northwindtimes.example/a" });
});

test("buildEdition uses the lead title as subject and items as editorial blocks", () => {
  const items = parseFeed(RSS, "rss");
  const edition = buildEdition(items, { baseCampaignId: "daily", editionKey: "2026-07-20" });
  assert.equal(edition.editionId, "daily-2026-07-20");
  assert.equal(edition.subject, "Markets rally");
  assert.equal(edition.template.blocks.length, 2);
  assert.equal(edition.template.blocks[0]?.kind, "editorial");
});

test("planLaunchDescriptor builds from feed items, else stamps a fresh id", () => {
  const template: EmailTemplate = { blocks: [{ kind: "text", html: "hi" }] };
  const payload: RecurringLaunchPayload = {
    descriptor: { orgId: "summit", campaignId: "daily", listId: "ledger", subject: "fallback", template },
    feed: { url: "https://northwindtimes.example/feed", format: "rss" },
    editionKey: "2026-07-20",
  };
  const withFeed = planLaunchDescriptor(payload, parseFeed(RSS, "rss"));
  assert.equal(withFeed.campaignId, "daily-2026-07-20");
  assert.equal(withFeed.subject, "Markets rally");

  const noFeed = planLaunchDescriptor({ ...payload, feed: undefined }, undefined);
  assert.equal(noFeed.campaignId, "daily-2026-07-20");
  assert.equal(noFeed.subject, "fallback"); // base subject reused
});
