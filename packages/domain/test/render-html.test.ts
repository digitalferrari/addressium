/**
 * Raw-HTML render pipeline (§4.15): per-recipient merge-tag escaping, `<a>`
 * tokenization + link-map for click tracking, and the baseline HTML sanitizer.
 * These are the security-relevant transforms the send path applies to HTML
 * bodies (raw_html mode / compiled MJML).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHtmlLinkMap,
  buildLinkMap,
  renderForRecipient,
  renderHtmlForRecipient,
  type EmailTemplate,
} from "@addressium/domain";

test("merge tags are substituted and HTML-escaped", () => {
  const out = renderHtmlForRecipient("<p>Hi {{first_name}}</p>", { first_name: "<b>Ann</b>&Co" }, "TOK");
  assert.match(out, /Hi &lt;b&gt;Ann&lt;\/b&gt;&amp;Co/);
  assert.doesNotMatch(out, /<b>Ann<\/b>/); // never rendered as markup
});

test("missing merge values render empty, not the literal tag", () => {
  const out = renderHtmlForRecipient("<p>Hi {{first_name}}!</p>", {}, "TOK");
  assert.match(out, /Hi !/);
});

test("dangerous link schemes are neutralized at render (#94)", () => {
  // The mjmlHtml path bypasses the sanitizer, so render must not tokenize a
  // javascript:/data: href into a live link.
  const js = renderHtmlForRecipient(`<a href="javascript:alert(1)">x</a>`, {}, "TOK");
  assert.doesNotMatch(js, /javascript:/i);
  assert.match(js, /href="#\S*tok=TOK"/); // rewritten to "#"

  const data = renderHtmlForRecipient(`<a href="data:text/html,evil">x</a>`, {}, "TOK");
  assert.doesNotMatch(data, /data:text\/html/i);

  // Legit absolute + relative links are preserved (just tokenized).
  const ok = renderHtmlForRecipient(`<a href="https://x.example/p">x</a>`, {}, "TOK");
  assert.match(ok, /href="https:\/\/x\.example\/p#tok=TOK"/);

  // Editorial block urls are guarded too.
  const block = renderForRecipient(
    { blocks: [{ kind: "editorial", label: "l", url: "javascript:alert(1)" }] },
    {},
    "TOK",
  );
  assert.doesNotMatch(block, /javascript:/i);
});

test("each anchor is tokenized in the fragment and gets a stable data-linkid", () => {
  const html = `<a href="https://x.example/a">A</a> then <a href="https://x.example/b">B</a>`;
  const out = renderHtmlForRecipient(html, {}, "TOK123");
  assert.match(out, /href="https:\/\/x\.example\/a#tok=TOK123"/);
  assert.match(out, /href="https:\/\/x\.example\/b#tok=TOK123"/);
  assert.match(out, /data-linkid="l0"/);
  assert.match(out, /data-linkid="l1"/);
});

test("an existing fragment is replaced, not appended, so the token stays valid", () => {
  const out = renderHtmlForRecipient(`<a href="https://x.example/a#section">A</a>`, {}, "TOK");
  assert.match(out, /href="https:\/\/x\.example\/a#tok=TOK"/);
  assert.doesNotMatch(out, /#section/);
});

test("the link-map aligns with the rendered link-ids and captures label + order", () => {
  const html = `<a href="https://x.example/a">First</a><p>mid</p><a href="https://x.example/b"><b>Second</b></a>`;
  const map = buildHtmlLinkMap(html);
  assert.equal(map.l0?.urlTemplate, "https://x.example/a");
  assert.equal(map.l0?.label, "First");
  assert.equal(map.l0?.position, 1);
  assert.equal(map.l1?.urlTemplate, "https://x.example/b");
  assert.equal(map.l1?.label, "Second"); // inner tags stripped for the label
  assert.equal(map.l1?.class, "editorial");
});

test("EmailTemplate with html routes through the HTML pipeline", () => {
  const t: EmailTemplate = { html: `<a href="https://x.example/a">A</a>` };
  assert.match(renderForRecipient(t, {}, "TOK"), /#tok=TOK/);
  assert.equal(buildLinkMap(t).l0?.urlTemplate, "https://x.example/a");
});
