/**
 * A feed url may name several sources (#309).
 *
 * A publication draws its main section from more than one feed — news, sport,
 * obituaries — and wants them in one story sequence. The stored url is a
 * comma-separated list, and order is the publisher's editorial decision: the
 * first source's lead item names the edition.
 *
 * The merge itself lives in the launch handler, which has no injection seam, so
 * the splitting is tested here and the per-source failure isolation is asserted
 * by the handler's own behaviour: one dead source costs a section, all sources
 * failing throws so the firing retries rather than sending a blank edition.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { splitFeedUrls } from "@addressium/domain";

test("a single url is one source", () => {
  assert.deepEqual(splitFeedUrls("https://x.test/rss"), ["https://x.test/rss"]);
});

test("several urls split in order", () => {
  // Order matters: the first source's lead item becomes the subject.
  assert.deepEqual(
    splitFeedUrls("https://x.test/news,https://x.test/sport,https://x.test/obits"),
    ["https://x.test/news", "https://x.test/sport", "https://x.test/obits"],
  );
});

test("whitespace around separators is tolerated", () => {
  // Operators paste these into a text field; a stray space must not become a
  // fetch of " https://…" that fails the url guard.
  assert.deepEqual(
    splitFeedUrls(" https://x.test/a , https://x.test/b "),
    ["https://x.test/a", "https://x.test/b"],
  );
});

test("empty entries are dropped rather than fetched", () => {
  // A trailing comma is the commonest edit artefact.
  assert.deepEqual(splitFeedUrls("https://x.test/a,,https://x.test/b,"), [
    "https://x.test/a",
    "https://x.test/b",
  ]);
});

test("an empty url yields no sources at all", () => {
  // Not one empty-string source, which would be fetched and fail.
  assert.deepEqual(splitFeedUrls(""), []);
  assert.deepEqual(splitFeedUrls("   "), []);
  assert.deepEqual(splitFeedUrls(","), []);
});

test("a url containing no comma is never split mid-path", () => {
  // Query strings legitimately contain commas in some CMSes; only a top-level
  // comma separates sources, and this documents that we do not try to be clever
  // about it — a publisher whose url contains a comma must url-encode it.
  const single = "https://x.test/rss?tags=news";
  assert.deepEqual(splitFeedUrls(single), [single]);
});
