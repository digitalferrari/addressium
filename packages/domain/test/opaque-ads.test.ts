/**
 * Third-party markup is passed through untouched (#313).
 *
 * The bug: `renderHtmlForRecipient` appends the per-recipient magic-link token
 * to EVERY anchor it finds. Ad html spliced in by `applySeriesAdFills` was
 * scanned like any other markup, so an org with magic links enabled handed a
 * subscriber credential to the ad server on every impression — and ad clicks
 * were counted as editorial engagement in the click map.
 *
 * The block renderer was never affected: an `ad` block is emitted verbatim and
 * `buildLinkMap` only maps `kind: "editorial"`. These pin the same guarantee
 * onto the raw-HTML path, and pin that editorial links did NOT lose their
 * tokens in the process — an over-correction would be its own bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applySeriesAdFills,
  buildLinkMap,
  opaque,
  renderForRecipient,
} from "@addressium/domain";

const AD = '<a href="https://ads.test/click?s=1"><img src="https://ads.test/imp?s=1"></a>';
const TOKEN = "SECRET-MAGIC-TOKEN";

const filled = () =>
  applySeriesAdFills(
    { html: '<html><body><p><a href="https://news.test/story">Story</a></p>{{ad_top}}</body></html>' },
    [{ slot: "ad_top", html: AD, binding: { kind: "series", seriesId: "s1" }, version: 1 }],
  );

test("the magic-link token never reaches an advertiser url", () => {
  const out = renderForRecipient(filled(), {}, TOKEN);
  const adHref = out.match(/ads\.test\/click[^"]*/)?.[0];
  assert.ok(adHref, "the ad must still render");
  assert.ok(!adHref.includes(TOKEN), "a subscriber credential must not be handed to the ad server");
});

test("editorial links still carry the token", () => {
  // The fix must not become "stop tokenizing" — the token is how a magic link
  // authenticates the reader on arrival.
  const out = renderForRecipient(filled(), {}, TOKEN);
  const editorial = out.match(/news\.test\/story[^"]*/)?.[0];
  assert.ok(editorial?.includes(`#tok=${TOKEN}`), "editorial links must keep working");
});

test("advertiser links are not counted as editorial engagement", () => {
  const urls = Object.values(buildLinkMap(filled())).map((e) => e.urlTemplate);
  assert.ok(
    urls.some((u) => u.includes("news.test")),
    "editorial links are still mapped",
  );
  assert.ok(!urls.some((u) => u.includes("ads.test")), "an ad click is not editorial engagement");
});

test("an opaque region survives verbatim, byte for byte", () => {
  // Ad tags carry tracking params and attribute quoting we must not normalise.
  const tricky = '<a href="https://ads.test/c?a=1&b=2" rel="nofollow" data-x=\'y\'>x</a>';
  const out = renderForRecipient({ html: `<body>${opaque(tricky)}</body>` }, {}, TOKEN);
  assert.ok(out.includes(tricky), "the markup must not be rewritten at all");
});

test("an unclosed opaque marker fails closed", () => {
  // Losing click tracking on the tail of a document is recoverable. Leaking the
  // token is not, so the rest of the document is treated as third-party.
  const out = renderForRecipient(
    { html: `<body><!--addressium:opaque--><a href="https://ads.test/c">x</a>` },
    {},
    TOKEN,
  );
  assert.ok(!out.includes(TOKEN), "no token past an unclosed marker");
});

test("anchors before and after an opaque region are still processed", () => {
  // The region must be a hole, not a wall — content after it is ours again.
  const out = renderForRecipient(
    {
      html:
        '<body><a href="https://news.test/a">A</a>' +
        opaque(AD) +
        '<a href="https://news.test/b">B</a></body>',
    },
    {},
    TOKEN,
  );
  assert.ok(out.match(/news\.test\/a[^"]*/)?.[0].includes(TOKEN), "before the region");
  assert.ok(out.match(/news\.test\/b[^"]*/)?.[0].includes(TOKEN), "after the region");
  assert.ok(!out.match(/ads\.test\/click[^"]*/)?.[0].includes(TOKEN), "but not inside it");
});

test("a campaign with no magic links is unaffected", () => {
  // Most orgs do not use magic links; adding the exemption must not change
  // their output.
  const withFix = renderForRecipient(filled(), {}, undefined);
  assert.ok(withFix.includes("ads.test/click?s=1"));
  assert.ok(!withFix.includes("#tok="));
});
