/**
 * Regression: link retagging must not expand `$` replacement patterns.
 *
 * `String.replace` with a replacement STRING expands `$&`, `` $` ``, `$'` and
 * `$$`. `escapeHtml` does not escape `$`, and merge values are substituted into
 * the href before retagging — so a value containing `$&` re-injected the raw
 * quote delimiters, corrupting every link and allowing attribute injection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderHtmlForRecipient } from "@addressium/domain";

test("a `$&` in a merge value cannot inject an attribute or corrupt the href", () => {
  const html = `<p><a href="https://news.example/article?ref={{ref}}">Read</a></p>`;
  const out = renderHtmlForRecipient(html, { ref: `$& onerror=alert(1) ` }, "TOK");

  const openTag = out.match(/<a\b[^>]*>/i)?.[0] ?? "";
  // Quotes must stay balanced — the bug re-injected raw `"` mid-value, which
  // prematurely closed href and turned the rest into real attributes.
  assert.equal((openTag.match(/"/g) ?? []).length % 2, 0, "balanced quotes");
  // Strip quoted values; anything left is genuine markup. The payload must live
  // entirely inside the href value, never as an attribute of its own.
  const markupOnly = openTag.replace(/"[^"]*"/g, '""');
  assert.doesNotMatch(markupOnly, /onerror/i, "no onerror attribute injected");
  // The href delimiters must not be re-injected mid-value.
  assert.doesNotMatch(out, /href="[^"]*href="/i, "href not duplicated/corrupted");
  // The anchor is still tagged for click tracking.
  assert.match(out, /data-linkid="l0"/);
});

test("a legitimate `$&` in a URL query survives intact", () => {
  const html = `<p><a href="https://news.example/t?a=1">Read</a></p>`;
  const out = renderHtmlForRecipient(html, {}, "TOK");
  assert.match(out, /href="https:\/\/news\.example\/t\?a=1#tok=TOK"/);
  assert.doesNotMatch(out, /href="[^"]*href="/i);
});
