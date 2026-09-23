/**
 * The per-edition placement id (#301).
 *
 * This is an EXTERNAL CONTRACT, not an internal choice. The value appears as
 * `p=` on every ad impression and click URL, and as `utm_id` on every story
 * link. Neither the ad server nor the analytics reporting changes at cutover,
 * so a "cleaner" id would silently break continuity in numbers nobody checks
 * until a monthly reconciliation.
 *
 * The two golden cases below are decoded from actual delivered mail. They are
 * the specification; everything else here documents why the format is the shape
 * it is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { placementId, formatSendTime } from "@addressium/domain";

test("reproduces a real delivered placement id, byte for byte", () => {
  assert.equal(
    placementId("VDN ad tags in SD Dev Daily News new vdn template", "2026-03-11 11:26:00"),
    "VkROYWR0YWdzaW5TRERldkRhaWx5TmV3c25ld3ZkbnRlbXBsYXRlMjAyNi0wMy0xMSAxMToyNjowMA==",
  );
});

test("reproduces a second, independently sampled id", () => {
  // Two samples from different publications, so the format is confirmed rather
  // than fitted to one example.
  assert.equal(
    placementId("Local News Flash", "2023-06-02 14:16:00"),
    "TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw",
  );
});

test("the name is stripped to letters, digits and hyphens", () => {
  // Spaces, apostrophes and punctuation all vanish from the NAME.
  const decoded = Buffer.from(placementId("A B's C-1!", "2026-01-01 00:00:00"), "base64").toString();
  assert.equal(decoded, "ABsC-12026-01-01 00:00:00");
});

test("the TIMESTAMP keeps its space and colons", () => {
  // This is why the result is not url-safe and callers must encode it. Stripping
  // the timestamp the way the name is stripped would change every id.
  const decoded = Buffer.from(placementId("N", "2026-01-01 09:30:05"), "base64").toString();
  assert.ok(decoded.includes(" "), "the space before the time is part of the contract");
  assert.ok(decoded.includes(":"), "so are the colons");
});

test("a Date and its formatted string produce the same id", () => {
  const at = new Date("2026-03-11T11:26:00Z");
  assert.equal(placementId("N", at), placementId("N", "2026-03-11 11:26:00"));
});

test("formatSendTime is UTC and zero-padded", () => {
  assert.equal(formatSendTime(new Date("2026-01-02T03:04:05Z")), "2026-01-02 03:04:05");
  assert.equal(formatSendTime(new Date("2026-12-31T23:59:59Z")), "2026-12-31 23:59:59");
});

test("two editions of the same newsletter get different ids", () => {
  // The whole point: it identifies an EDITION, not a series.
  assert.notEqual(
    placementId("The Daily", "2026-03-11 06:00:00"),
    placementId("The Daily", "2026-03-12 06:00:00"),
  );
});

test("the same edition always produces the same id", () => {
  // A retry must not re-key the ad server's impression counts.
  assert.equal(
    placementId("The Daily", "2026-03-11 06:00:00"),
    placementId("The Daily", "2026-03-11 06:00:00"),
  );
});

/**
 * The server/provider substitution boundary.
 *
 * Every `{{…}}` token in an ad tag is resolved BY US except `{{Address}}`,
 * which passes through to the ESP's per-recipient templating. The names are
 * misleading — `{{MessageVersionInstance.Id}}` looks exactly like a merge
 * variable and is not one — and getting it backwards ships literal token text
 * to subscribers, or worse, fails to identify the edition to the ad server.
 */
import { composeFromRegions } from "@addressium/domain";

const TEMPLATE =
  "<body>{{MARQUEEAD}}<!-- START MAIN STORY --><h1>{{HEADLINE}}</h1><!-- END MAIN STORY -->" +
  "<!-- START BODY STORY --><p>{{HEADLINE}}</p><!-- END BODY STORY -->{{SAFERTB}}</body>";

const AD_TAG =
  '<a href="https://sli.test/click?s=1&li={LIST_ID}&e={{Address}}&p={{MessageVersionInstance.Id}}">' +
  '<img src="https://sli.test/imp?s=1&li={LIST_ID}&e={{Address}}&p={{MessageVersionInstance.Id}}"></a>';

const composed = () =>
  composeFromRegions(
    TEMPLATE,
    [{ headline: "H", url: "https://x.test/1" }],
    { marquee: AD_TAG },
    {},
    "PLACEMENT123",
    "seg-42",
  );

test("the placement id is substituted server-side, everywhere it appears", () => {
  const out = composed();
  assert.equal(out.match(/p=PLACEMENT123/g)?.length, 2, "both the click and impression urls");
  assert.ok(!out.includes("{{MessageVersionInstance.Id}}"), "no literal token may ship");
});

test("the list id is substituted server-side too", () => {
  const out = composed();
  assert.equal(out.match(/li=seg-42/g)?.length, 2);
  assert.ok(!out.includes("{LIST_ID}"));
});

test("{{Address}} is left alone for the provider to resolve", () => {
  // The single most consequential detail: this is the ONE token that survives
  // into per-recipient templating. Resolving it here would send every
  // subscriber the same address, breaking the ad server's per-recipient
  // attribution entirely.
  const out = composed();
  assert.equal(out.match(/e=\{\{Address\}\}/g)?.length, 2, "must pass through untouched");
});
