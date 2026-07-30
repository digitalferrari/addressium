/**
 * Click attribution for personalised links (#201).
 *
 * `urlTemplate` is stored UNRENDERED — `https://x.com/a?u={{email}}` — while the
 * recipient clicks the RENDERED url. Exact string equality can never match
 * those, so every click on a link containing a merge tag resolved to no link-id:
 * the click was recorded, the campaign's click COUNT was right, and the click
 * MAP showed zero for that link.
 *
 * Silent, and worst on exactly the personalised links an operator most wants to
 * measure — a "read your personalised digest" link reports as never clicked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { matchesUrlTemplate, memStores, recordClick, buildClickMap, type Clock } from "@addressium/domain";

const clock: Clock = { now: () => new Date("2026-07-28T12:00:00.000Z") };
const ORG = "summit";
const CAMPAIGN = "c1";

test("a rendered merge tag still resolves to its link", () => {
  assert.equal(
    matchesUrlTemplate("https://x.com/a?u={{email}}", "https://x.com/a?u=reader%40x.com"),
    true,
  );
  assert.equal(
    matchesUrlTemplate("https://x.com/{{city}}/news", "https://x.com/frisco/news"),
    true,
  );
  assert.equal(
    matchesUrlTemplate("https://x.com/{{a}}/p/{{b}}", "https://x.com/1/p/2"),
    true,
    "several tags, matched in order",
  );
});

test("a link with no merge tag still requires exact equality", () => {
  // The fast path, and the behaviour every existing link relies on.
  assert.equal(matchesUrlTemplate("https://x.com/a", "https://x.com/a"), true);
  assert.equal(matchesUrlTemplate("https://x.com/a", "https://x.com/b"), false);
  assert.equal(matchesUrlTemplate("https://x.com/a", "https://x.com/a?utm=1"), false);
});

test("a template does not match a different link", () => {
  // The failure that matters in the other direction: over-matching would
  // attribute clicks to the wrong row, which is worse than attributing none.
  assert.equal(matchesUrlTemplate("https://x.com/a?u={{email}}", "https://evil.com/a?u=x"), false);
  assert.equal(matchesUrlTemplate("https://x.com/a?u={{email}}", "https://x.com/b?u=x"), false);
  assert.equal(
    matchesUrlTemplate("https://x.com/{{a}}/news", "https://x.com/frisco/sports"),
    false,
    "the literal suffix must still match",
  );
});

test("the ends cannot overlap to fake a match", () => {
  // `a{{x}}a` must not match a bare "a" by letting the prefix and suffix be the
  // same character.
  assert.equal(matchesUrlTemplate("a{{x}}a", "a"), false);
  assert.equal(matchesUrlTemplate("a{{x}}a", "aa"), true);
});

test("interior literals must appear IN ORDER", () => {
  assert.equal(matchesUrlTemplate("s/{{a}}/mid/{{b}}/e", "s/1/mid/2/e"), true);
  assert.equal(matchesUrlTemplate("s/{{a}}/mid/{{b}}/e", "s/1/2/e"), false, "mid is missing");
});

test("a pathological template does not hang", () => {
  // A regex built from `{{x}}` → `.*` backtracks; the scan is linear. If this
  // ever regresses to a quadratic matcher the test run stops rather than fails,
  // which is the signal.
  const template = `https://x.com/${"{{a}}/".repeat(200)}end`;
  const url = `https://x.com/${"z/".repeat(2000)}nope`;
  const started = Date.now();
  assert.equal(matchesUrlTemplate(template, url), false);
  assert.ok(Date.now() - started < 1000, "matcher must stay linear");
});

test("end to end: a click on a personalised link lands in the click map", async () => {
  const stores = memStores();
  await stores.archive.put({
    orgId: ORG,
    campaignId: CAMPAIGN,
    s3Key: "archive/c1.html",
    linkMap: {
      l0: { urlTemplate: "https://x.com/read?u={{email}}", position: 1, label: "Your digest", class: "editorial" },
      l1: { urlTemplate: "https://x.com/plain", position: 2, label: "Plain", class: "editorial" },
    },
  });
  await stores.campaigns.put({
    orgId: ORG,
    campaignId: CAMPAIGN,
    type: "one_off",
    subject: "s",
    templateId: "t",
    audience: { listId: "l" },
    status: "sent",
    counters: { sent: 1, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0 },
  });

  const linkId = await recordClick(stores, clock, {
    orgId: ORG,
    campaignId: CAMPAIGN,
    subscriberId: "s1",
    // Rendered, and carrying the magic-link fragment the browser sends.
    clickedUrl: "https://x.com/read?u=reader%40x.com#tok=abc",
  });
  assert.equal(linkId, "l0", "the personalised link used to resolve to nothing");

  const map = await buildClickMap(stores, ORG, CAMPAIGN);
  assert.equal(map.rows.find((r) => r.linkId === "l0")?.clicks, 1);
  assert.equal(map.rows.find((r) => r.linkId === "l1")?.clicks, 0);
});

test("an exact link wins over a template that would also match", async () => {
  // A campaign can carry both. Resolving by enumeration order would attribute
  // the click to whichever came first.
  const stores = memStores();
  await stores.archive.put({
    orgId: ORG,
    campaignId: CAMPAIGN,
    s3Key: "archive/c1.html",
    linkMap: {
      l0: { urlTemplate: "https://x.com/{{a}}", position: 1, label: "Templated", class: "editorial" },
      l1: { urlTemplate: "https://x.com/exact", position: 2, label: "Exact", class: "editorial" },
    },
  });
  const linkId = await recordClick(stores, clock, {
    orgId: ORG,
    campaignId: CAMPAIGN,
    subscriberId: "s1",
    clickedUrl: "https://x.com/exact",
  });
  assert.equal(linkId, "l1");
});
