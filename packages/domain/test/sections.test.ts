/**
 * Region-based template assembly (#299) and ad interleaving (#300).
 *
 * The model these newsletters use: the operator designs a whole HTML email and
 * marks where stories go; each firing expands those regions from the current
 * feed and leaves the rest byte for byte. That is the inverse of `buildEdition`,
 * which builds a body out of feed items and throws the composed one away —
 * right for a bare list of links, wrong for a designed publication where the
 * template is the product.
 *
 * Several of these assert against `docs/default-newsletter-template.html`, the
 * real production template, because a region parser that only handles the
 * canonical spelling is worthless: that file carries `<!--- BEGIN MAGAZINES-->`
 * next to `<!-- START MAIN STORY -->`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { findRegion, renderStory, expandRegion, type SectionStory } from "@addressium/domain";

const here = dirname(fileURLToPath(import.meta.url));
const realTemplate = readFileSync(
  resolve(here, "../../../../docs/default-newsletter-template.html"),
  "utf8",
);

const story = (n: string): SectionStory => ({
  headline: `Headline ${n}`,
  url: `https://example.test/${n}`,
  image: `https://example.test/${n}.jpg`,
  bodyText: `Body text ${n}`,
});

test("every region of the real production template is found", () => {
  for (const name of [
    "MAIN STORY",
    "BODY STORY",
    "NEWSLETTER_AFTERMAINONE_STORIES",
    "NEWSLETTER_AFTERMAINTWO_STORIES",
  ]) {
    const r = findRegion(realTemplate, name);
    assert.ok(r, `${name} must be found in the shipped template`);
    assert.ok(r.inner.length > 100, `${name} looks empty — delimiters matched the wrong span`);
  }
});

test("delimiter spelling variations are tolerated", () => {
  // The real template mixes these. A parser that only accepts one spelling
  // silently drops whichever sections use the other.
  for (const [open, close] of [
    ["<!-- START X -->", "<!-- END X -->"],
    ["<!-- BEGIN X -->", "<!-- END X -->"],
    ["<!--- BEGIN X-->", "<!--- END X-->"],
    ["<!--START X-->", "<!--END X-->"],
  ]) {
    const r = findRegion(`before${open}INNER${close}after`, "X");
    assert.ok(r, `${open} … ${close} must parse`);
    assert.equal(r.inner, "INNER");
  }
});

test("a missing region is undefined, not a crash", () => {
  // Not every template has every section — NOIMAGE is absent from the shipped
  // one entirely — so the caller decides, rather than this throwing.
  assert.equal(findRegion("<p>no regions here</p>", "MAIN STORY"), undefined);
  assert.equal(findRegion("<!-- START X -->unclosed", "X"), undefined);
});

test("every per-story token is substituted, everywhere it appears", () => {
  // {{URL}} appears 11 times in the real template — image link, headline link
  // and Read More button all point at the same story.
  const out = renderStory(
    `<a href="{{URL}}"><img src="{{IMG}}"></a><h1><a href="{{URL}}">{{HEADLINE}}</a></h1>
     <p>{{BODYTEXT}}</p><a href="{{URL}}">Read More</a>`,
    story("a"),
  );
  assert.equal(out.match(/example\.test\/a(?!\.jpg)/g)?.length, 3, "all three URL slots");
  assert.ok(out.includes("Headline a"));
  assert.ok(out.includes("example.test/a.jpg"));
  assert.ok(out.includes("Body text a"));
  assert.ok(!/\{\{[A-Z]+\}\}/.test(out), "no token may survive");
});

test("story values are escaped", () => {
  // Feed content is third-party text arriving over the network.
  const out = renderStory(`<a href="{{URL}}">{{HEADLINE}}</a>`, {
    headline: '<script>alert(1)</script>',
    url: 'https://x.test/"onerror="alert(1)',
  });
  assert.ok(!out.includes("<script>"), "markup must not survive a headline");
  assert.ok(!/href="[^"]*"on/i.test(out), "a quote in a url must not break out of the attribute");
});

test("a missing image or body text renders empty, not the literal token", () => {
  const out = renderStory(`<img src="{{IMG}}"><p>{{BODYTEXT}}</p>`, {
    headline: "H",
    url: "https://x.test/1",
  });
  assert.ok(!out.includes("{{IMG}}"));
  assert.ok(!out.includes("{{BODYTEXT}}"));
});

test("story 0 uses the lead layout and the rest use the item layout", () => {
  // Position picks the layout, not category: the first story is the large one
  // with a full-width image, the rest are smaller.
  const out = expandRegion(
    { lead: "<LEAD>{{HEADLINE}}</LEAD>", item: "<ITEM>{{HEADLINE}}</ITEM>" },
    [story("a"), story("b"), story("c")],
  );
  assert.equal(out.match(/<LEAD>/g)?.length, 1, "exactly one lead");
  assert.equal(out.match(/<ITEM>/g)?.length, 2);
  assert.ok(out.indexOf("<LEAD>") < out.indexOf("<ITEM>"), "the lead comes first");
});

test("a section with no lead repeats one layout for every story", () => {
  // The two AFTERMAIN category blocks work this way.
  const out = expandRegion({ item: "<ITEM>{{HEADLINE}}</ITEM>" }, [story("a"), story("b")]);
  assert.equal(out.match(/<ITEM>/g)?.length, 2);
});

test("one ad follows each story, in order, until the ads run out", () => {
  // The confirmed rule (#300): not every-N, not a position list.
  const out = expandRegion(
    { item: "<S>{{HEADLINE}}</S>" },
    [story("a"), story("b"), story("c")],
    { ads: ["<AD1>", "<AD2>"] },
  );
  const seq = [...out.matchAll(/<S>|<AD\d>/g)].map((m) => m[0]);
  assert.deepEqual(seq, ["<S>", "<AD1>", "<S>", "<AD2>", "<S>"], "story, ad, story, ad, story");
});

test("more stories than ads: the later stories simply get none", () => {
  // 6-8 stories against 3-9 ads — this is ordinary, not an edge case.
  const out = expandRegion({ item: "<S>" }, [story("a"), story("b"), story("c"), story("d")], {
    ads: ["<AD1>"],
  });
  assert.equal(out.match(/<AD1>/g)?.length, 1, "no reuse");
  assert.equal(out.match(/<S>/g)?.length, 4, "every story still renders");
});

test("more ads than stories: the surplus is dropped, never wrapped around", () => {
  const out = expandRegion({ item: "<S>" }, [story("a")], { ads: ["<AD1>", "<AD2>", "<AD3>"] });
  assert.equal(out.match(/<AD1>/g)?.length, 1);
  assert.ok(!out.includes("<AD2>"), "an unsold slot is not a place to repeat a sold one");
});

test("ads are wrapped in the operator's chrome", () => {
  // The legacy wrapper is a divider, the word "Advertisement", and a divider —
  // disclosure that has to be there whatever the creative is.
  const out = expandRegion({ item: "<S>" }, [story("a")], {
    ads: ["<CREATIVE>"],
    adWrapper: "<W>Advertisement{{ADPLACEMENT}}</W>",
  });
  assert.ok(out.includes("<W>Advertisement<CREATIVE></W>"));
});

test("maxItems caps a section", () => {
  // AFTERMAINONE takes 3 and AFTERMAINTWO takes 2, however long the feed is.
  const stories = ["a", "b", "c", "d", "e"].map(story);
  assert.equal(expandRegion({ item: "<S>" }, stories, { maxItems: 3 }).match(/<S>/g)?.length, 3);
  assert.equal(expandRegion({ item: "<S>" }, stories, { maxItems: 2 }).match(/<S>/g)?.length, 2);
});

test("no stories renders nothing, rather than an empty shell", () => {
  // An empty feed must not produce a masthead-and-footer email with a blank
  // middle — the launch handler refuses the edition before it gets here, and
  // this is the second line of that defence.
  assert.equal(expandRegion({ item: "<S>{{HEADLINE}}</S>" }, []), "");
});

test("the real template's regions expand with real-shaped stories", () => {
  // End to end on the shipped template rather than a fixture, because the
  // fixture is the thing most likely to be wrong.
  const main = findRegion(realTemplate, "MAIN STORY")!;
  const body = findRegion(realTemplate, "BODY STORY")!;
  const out = expandRegion({ lead: main.inner, item: body.inner }, [story("a"), story("b")], {
    ads: ["<img src='https://ads.test/1'>"],
    adWrapper: "<div>Advertisement{{ADPLACEMENT}}</div>",
  });
  assert.ok(out.includes("Headline a") && out.includes("Headline b"));
  assert.ok(out.includes("ads.test/1"));
  assert.ok(!/\{\{(URL|HEADLINE|IMG|BODYTEXT)\}\}/.test(out), "no per-story token may survive");
  assert.ok(out.includes("Read More"), "the template's own chrome survives");
});

/**
 * Composing a whole edition from a designed template (#299, #300).
 *
 * `composeFromRegions` is what the launch path calls: it expands every story
 * region from the current feed, interleaves ads in the main run, fills the
 * document-level labels, and leaves everything else byte for byte.
 */
import { composeFromRegions, planLaunchDescriptor, hasStoryRegions } from "@addressium/domain";

const feedItems = [
  { title: "Lead story", link: "https://x.test/1", image: "https://x.test/1.jpg", content: "<p>Dek one</p>" },
  { title: "Second story", link: "https://x.test/2", image: "https://x.test/2.jpg", content: "<p>Dek two</p>" },
  { title: "Third story", link: "https://x.test/3", image: "https://x.test/3.jpg", content: "<p>Dek three</p>" },
];

test("a designed template composes the feed into itself and keeps its chrome", () => {
  const out = composeFromRegions(
    realTemplate,
    [story("a"), story("b"), story("c")],
    undefined,
    { NEWSLETTERNAME: "The Daily" },
  );
  // The operator's furniture survives — this is the whole point.
  for (const chrome of ["Manage Newsletters", "Got a story idea", "Meet Steamboat Pilot"]) {
    assert.ok(out.includes(chrome), `template chrome lost: ${chrome}`);
  }
  assert.ok(out.includes("Headline a") && out.includes("Headline c"));
  assert.ok(out.includes("The Daily"));
});

test("category sections are NOT filled from the main feed", () => {
  // They are separately sourced. Filling all three from one feed printed the
  // same stories three times under different headings.
  const out = composeFromRegions(realTemplate, [story("a"), story("b")]);
  assert.equal(
    out.match(/Headline a/g)?.length,
    1,
    "a story must appear once, not once per section",
  );
});

test("each section can be sourced independently", () => {
  const out = composeFromRegions(realTemplate, {
    main: [story("m1"), story("m2")],
    categoryOne: [story("c1")],
    categoryTwo: [story("c2")],
  });
  assert.ok(out.includes("Headline m1") && out.includes("Headline c1") && out.includes("Headline c2"));
});

test("ads interleave in the main run and nowhere else", () => {
  // Confirmed rule: the two AFTERMAIN sections get no ads.
  const out = composeFromRegions(
    realTemplate,
    { main: [story("m1"), story("m2")], categoryOne: [story("c1"), story("c2"), story("c3")] },
    { body: ["<AD1>", "<AD2>", "<AD3>"] },
  );
  const mainEnd = out.indexOf("Headline c1");
  const adsBeforeCategory = (out.slice(0, mainEnd).match(/<AD\d>/g) ?? []).length;
  const adsAfter = (out.slice(mainEnd).match(/<AD\d>/g) ?? []).length;
  assert.equal(adsBeforeCategory, 2, "one ad after each of the two main stories");
  assert.equal(adsAfter, 0, "the category sections take no ads");
});

test("marquee and footer are single fixed placements", () => {
  const out = composeFromRegions(realTemplate, [story("a")], {
    marquee: "<MARQUEE-AD>",
    footer: "<FOOTER-BEACON>",
  });
  assert.equal(out.match(/<MARQUEE-AD>/g)?.length, 1);
  assert.equal(out.match(/<FOOTER-BEACON>/g)?.length, 1);
  assert.ok(out.indexOf("<MARQUEE-AD>") < out.indexOf("<FOOTER-BEACON>"), "top, then bottom");
});

test("ad html is marked opaque so the token scanner passes over it", () => {
  // #313: advertiser markup must not have the per-recipient magic-link token
  // appended to it, and must not be counted as editorial engagement.
  const out = composeFromRegions(realTemplate, [story("a")], { marquee: "<MARQUEE-AD>" });
  assert.ok(out.includes("<!--addressium:opaque--><MARQUEE-AD>"), "ads must be wrapped opaque");
});

test("per-recipient merge tags are NOT swept away", () => {
  // The trap in clearing unfilled document tokens: merge tags are resolved much
  // later, per recipient. A blanket [A-Z_]+ sweep would delete the unsubscribe
  // link before it was ever substituted.
  const tpl =
    `<body>{{NEWSLETTERNAME}}<!-- START MAIN STORY --><h1>{{HEADLINE}}</h1><!-- END MAIN STORY -->` +
    `<!-- START BODY STORY --><p>{{HEADLINE}}</p><!-- END BODY STORY -->` +
    `<a href="{{unsubscribe_url}}">Unsubscribe</a>{{first_name}}{{compliance_footer}}</body>`;
  const out = composeFromRegions(tpl, [story("a")], undefined, { NEWSLETTERNAME: "The Daily" });
  for (const tag of ["unsubscribe_url", "first_name", "compliance_footer"]) {
    assert.ok(out.includes(`{{${tag}}}`), `${tag} must survive to be resolved per recipient`);
  }
});

test("an unfilled document token is blanked, not left visible", () => {
  // `{{CATEGORYONENICENAME}}` in an inbox is worse than an empty heading.
  const out = composeFromRegions(realTemplate, [story("a")]);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(out), "no literal placeholder may ship");
});

test("the launch path uses region composition only when the template opts in", () => {
  // Opt-in on the template carrying a main story region, so a series scheduled
  // before this keeps the old buildEdition behaviour and a composed body that
  // has never been reviewed is not suddenly mailed.
  const payload = {
    descriptor: {
      orgId: "acme", campaignId: "daily", listId: "ledger", subject: "Frozen",
      template: { blocks: [{ kind: "text" as const, html: "<p>old</p>" }] },
    },
    feed: { url: "https://x.test/rss", format: "rss" as const },
    editionKey: "2026-09-23",
  };

  // No regions: the old path.
  const legacy = planLaunchDescriptor(payload, feedItems, undefined);
  assert.ok(legacy.template.blocks, "a template with no regions still uses buildEdition");

  // Regions present: composed.
  const composed = planLaunchDescriptor(payload, feedItems, { template: { html: realTemplate } });
  assert.ok(composed.template.html, "a designed template composes");
  assert.ok(composed.template.html.includes("Lead story"));
  assert.ok(composed.template.html.includes("Manage Newsletters"), "and keeps its chrome");
  assert.equal(composed.subject, "Lead story", "the lead story still names the edition");
});

test("hasStoryRegions is the opt-in signal", () => {
  assert.equal(hasStoryRegions({ html: realTemplate }), true);
  assert.equal(hasStoryRegions({ html: "<p>plain</p>" }), false);
  assert.equal(hasStoryRegions({ blocks: [{ kind: "text", html: "<p>x</p>" }] }), false);
});
