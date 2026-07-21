/**
 * ReDoS regression guard (CodeQL js/polynomial-redos, js/incomplete-multi-character-sanitization).
 * Each of these once used an ambiguous regex on untrusted input; feeding a large
 * pathological string that would take minutes under quadratic backtracking must
 * now complete effectively instantly. If any of these regresses to O(n²), the
 * test run hangs and fails — that's the signal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  redactForLlm,
  slugifyOrgId,
  buildHtmlLinkMap,
  renderHtmlForRecipient,
  parseFeed,
} from "@addressium/domain";

const N = 100_000;

test("redactForLlm handles a long no-'@' run fast and still redacts real emails", () => {
  assert.equal(redactForLlm("%".repeat(N) + " x"), "%".repeat(N) + " x");
  assert.match(redactForLlm("reach me at a@b.com please"), /\[redacted\]/);
});

test("slugifyOrgId handles a huge interior dash run fast", () => {
  assert.equal(slugifyOrgId("a" + "-".repeat(N) + "b"), "a-b");
  assert.equal(slugifyOrgId("  Hello, World!  "), "hello-world");
});

test("buildHtmlLinkMap / stripTags handle many '<' fast and strip tags completely", () => {
  assert.deepEqual(buildHtmlLinkMap("<".repeat(N)), {});
  const map = buildHtmlLinkMap(`<a href="https://x.example/a">Se<b>cond</b></a>`);
  assert.equal(map.l0?.label, "Second"); // nested tags fully stripped, not reformed
});

test("renderHtmlForRecipient handles many unterminated '<a' fast", () => {
  const out = renderHtmlForRecipient("<a".repeat(N), {}, "TOK");
  assert.equal(out, "<a".repeat(N)); // no href anywhere ⇒ nothing tokenized
});

test("parseFeed(atom) handles a CDATA-heavy / many-<link entry fast", () => {
  const entry = `<entry><title><![CDATA[${"a".repeat(N)}]]></title>` + "<link".repeat(1000) + ` href="https://x.example/z"/></entry>`;
  const items = parseFeed(`<feed>${entry}</feed>`, "atom");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.link, "https://x.example/z");
});
