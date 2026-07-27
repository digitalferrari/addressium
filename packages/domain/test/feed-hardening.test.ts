/**
 * Feed parsing hardening.
 *
 * #173 — `blocksBetween` was quadratic: `<name…>([\s\S]*?)</name>` over a body
 *        with many openers and no closer took 5.4s at 256 KiB, extrapolating to
 *        minutes at the 5 MiB fetch cap. It is now a linear indexOf scan.
 * #174 — an unparseable feed yields [] rather than throwing, which must never
 *        become an edition (that sent a blank email to the entire list).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseFeed, buildEdition, templateIsEmpty } from "@addressium/domain";

test("unclosed-tag flood parses in linear time, not quadratic", () => {
  // 600 KiB of openers with no closer — the old regex exceeded the 30s Lambda
  // timeout on this input. Budget is generous so the test isn't flaky on slow
  // CI; the point is that it is no longer O(n^2).
  const hostile = "<item>".repeat(100_000);
  const started = process.hrtime.bigint();
  const items = parseFeed(hostile, "rss");
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(items.length, 0, "no complete blocks, so no items");
  assert.ok(ms < 2000, `parsing took ${ms.toFixed(0)}ms — expected linear`);
});

test("well-formed feeds still parse, including attributes and CDATA", () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[Hello & welcome]]></title><link>https://a.example/1</link></item>
    <item foo="bar"><title>Second</title><link>https://a.example/2</link></item>
    <items><title>not an item</title></items>
  </channel></rss>`;
  const items = parseFeed(xml, "rss");
  assert.equal(items.length, 2, "<items> must not match <item>");
  assert.equal(items[0]?.title, "Hello & welcome");
  assert.equal(items[1]?.title, "Second");
  assert.equal(items[1]?.link, "https://a.example/2");
});

test("an empty item set builds an empty template, which is detectably empty", () => {
  const edition = buildEdition([], { baseCampaignId: "daily", editionKey: "20260727" });
  assert.equal(edition.subject, "Your newsletter");
  assert.equal(templateIsEmpty(edition.template), true, "empty blocks must be flagged");

  const real = buildEdition(
    [{ title: "A story", link: "https://a.example/1" }],
    { baseCampaignId: "daily", editionKey: "20260727" },
  );
  assert.equal(templateIsEmpty(real.template), false);
});

test("templateIsEmpty covers the raw-html shape too", () => {
  assert.equal(templateIsEmpty({ html: "   " }), true);
  assert.equal(templateIsEmpty({ html: "<p>hi</p>" }), false);
});
