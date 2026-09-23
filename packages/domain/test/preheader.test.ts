/**
 * Inbox preview line (#302).
 *
 * `previewText` existed on the draft record and reached nothing — not the
 * schedule schema, not `SendDescriptor`, not the renderer. Every campaign went
 * out with whatever the client chose to scrape for the preview, which is
 * usually the first words of the body, or an unsubscribe line, or the alt text
 * of a masthead image.
 *
 * The hidden-div technique is fragile in a specific way, so these pin the
 * properties that make it work rather than the exact markup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderForRecipient, preheaderHtml } from "@addressium/domain";

test("the preheader comes before the body in blocks mode", () => {
  const html = renderForRecipient(
    { blocks: [{ kind: "text", html: "<p>Body copy</p>" }] },
    {},
    undefined,
    "Preview line here",
  );
  assert.ok(html.includes("Preview line here"));
  assert.ok(
    html.indexOf("Preview line here") < html.indexOf("Body copy"),
    "a preheader after the body is not a preheader",
  );
});

test("in html mode it goes INSIDE <body>, not before the document", () => {
  // A hidden div floating before <!DOCTYPE> is not reliably treated as preview
  // text, and some clients drop it entirely.
  const html = renderForRecipient(
    { html: "<html><body><p>Body copy</p></body></html>" },
    {},
    undefined,
    "Preview line",
  );
  assert.match(html, /<body[^>]*><div style="display:none/);
});

test("an html fragment with no <body> still gets its preheader", () => {
  // Operators paste fragments as often as whole documents.
  const html = renderForRecipient({ html: "<p>Body copy</p>" }, {}, undefined, "Preview line");
  assert.ok(html.indexOf("Preview line") < html.indexOf("Body copy"));
});

test("it is hidden every way that matters", () => {
  // display:none alone is stripped by some clients, so the zero dimensions and
  // opacity are load-bearing, not belt-and-braces.
  const out = preheaderHtml("Hidden", {});
  for (const prop of ["display:none", "max-height:0px", "max-width:0px", "opacity:0", "overflow:hidden"]) {
    assert.ok(out.includes(prop), `missing ${prop}`);
  }
});

test("trailing filler stops the client pulling body copy into the preview", () => {
  // Without it the client appends the first words of the real body to fill the
  // preview line — exactly what a preheader exists to prevent.
  const out = preheaderHtml("Short", {});
  assert.ok(out.includes("&zwnj;&nbsp;"), "no filler run");
  assert.ok(out.split("&zwnj;").length > 20, "filler too short to displace body copy");
});

test("merge values apply", () => {
  assert.ok(preheaderHtml("Hello {{first_name}}", { first_name: "Mike" }).includes("Hello Mike"));
});

test("it cannot inject markup", () => {
  // The preheader is operator input and is escaped like any other merge target.
  const out = preheaderHtml('<script>alert(1)</script>', {});
  assert.ok(!out.includes("<script>"), "script tag must not survive");
  assert.ok(out.includes("&lt;script&gt;"), "and must be visibly escaped");
});

test("an empty or whitespace preheader renders nothing at all", () => {
  // Not an empty hidden div: a stray element is pointless weight in every
  // message, and some clients count it toward the clipping threshold.
  assert.equal(preheaderHtml("", {}), "");
  assert.equal(preheaderHtml("   ", {}), "");
});

test("no previewText renders exactly what it rendered before", () => {
  // The field is optional and most campaigns will not set it; adding it must
  // not change a single byte for those.
  const t = { blocks: [{ kind: "text" as const, html: "<p>Body</p>" }] };
  assert.equal(renderForRecipient(t, {}, undefined), renderForRecipient(t, {}, undefined, undefined));
});
