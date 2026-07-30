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
  slugifyOrgId,
  buildHtmlLinkMap,
  renderHtmlForRecipient,
  parseFeed,
  matchesUrlTemplate,
} from "@addressium/domain";

const N = 100_000;

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

test("matchesUrlTemplate handles a huge unterminated '{{' run fast (CodeQL #29)", () => {
  // The function's own comment said a scan "is linear and cannot" backtrack —
  // true of the MATCHING, and false of the tokenising it depended on. The split
  // was `/\{\{[^}]*\}\}/`: `[^}]*` cannot cross a `}`, so on a run of `{` with no
  // closing `}}` the engine consumed to the end, failed, and retried from the
  // next index. Measured 134ms at 12.5k and 8.7s at 100k — 4x per doubling.
  //
  // Reachable because `urlTemplate` comes from the campaign's archived link map
  // (operator-authored) and this runs once per link per CLICK event, so one
  // pathological URL made every click on that campaign quadratic.
  assert.equal(matchesUrlTemplate("{".repeat(N), "zzz"), false);
  assert.equal(matchesUrlTemplate("{{" + "a".repeat(N), "zzz"), false);
  assert.equal(matchesUrlTemplate("{".repeat(N) + "}", "zzz"), false);

  // ...and the semantics the tokeniser exists for are unchanged.
  assert.equal(
    matchesUrlTemplate("https://x.example/a?u={{email}}", "https://x.example/a?u=reader%40x.example"),
    true,
  );
  assert.equal(matchesUrlTemplate("https://x.example/a?u={{email}}", "https://other.example/"), false);
  // A tag body may not contain `}` — `{{a}b}}` is literal text, not a tag, so
  // this template has no tags at all and only exact equality can match it.
  assert.equal(matchesUrlTemplate("{{a}b}}", "anything"), false);
  assert.equal(matchesUrlTemplate("{{a}b}}", "{{a}b}}"), true);
  // The ends must not overlap: `a{{x}}a` needs both an `a` prefix and suffix.
  assert.equal(matchesUrlTemplate("a{{x}}a", "a"), false);
  assert.equal(matchesUrlTemplate("a{{x}}a", "aQQa"), true);
});
