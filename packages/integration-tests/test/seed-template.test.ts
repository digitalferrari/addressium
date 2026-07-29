/**
 * The primary test template (#204).
 *
 * The point of a canonical smoke-test body is that a test send exercises the
 * whole render path rather than whatever the operator happened to paste in. Two
 * genuine defects fell out of building it, and they are what most of these tests
 * are about:
 *
 * 1. **No campaign send ever set a plain-text part.** `SentMessage.text` has
 *    existed since the port was written and nothing assigned it, so every
 *    newsletter went out HTML-only — a spam-score signal at every major provider,
 *    and simply broken for people who read mail as text.
 * 2. **`{{unsubscribe_url}}` rendered empty.** Merge values came only from
 *    `subscriber.attributes`, and no subscriber has an `unsubscribe_url`
 *    attribute — so the obvious way to write the one link a recipient is legally
 *    entitled to produced `href=""`. It looked right in every preview, because
 *    the link was still there and still blue.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClickMap,
  memStores,
  plainTextFrom,
  primaryTestBlocks,
  primaryTestHtml,
  primaryTestMjml,
  primaryTestSource,
  provisionOrganization,
  recordClick,
  seedTemplateSmokeCheck,
  sendCampaign,
  SystemClock,
  PRIMARY_TEST_TEMPLATE_ID,
  type EmailSender,
  type ProvisioningProviders,
  type SentMessage,
  type UnsubscribeLinkBuilder,
} from "@addressium/domain";
import { GsiSegmentEngine } from "@addressium/segment";
import type { List, schemas, Subscriber, Subscription } from "@addressium/core";

const ORG = "summit";
const LIST = "ledger";
const clock = new SystemClock();

function recordingSender(): EmailSender & { sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return { sent, async send(msg) { sent.push(msg); } };
}

/** The real shape: a signed https URL, per recipient. */
const unsubscribeLink: UnsubscribeLinkBuilder = {
  async build({ orgId, subscriberId, listId }) {
    return `https://mail.example/u?o=${orgId}&s=${subscriberId}&l=${listId}&t=sig`;
  },
};

async function seed() {
  const stores = memStores();
  const list: List = {
    orgId: ORG, listId: LIST, name: "The Ledger", optInPolicy: "double",
    fromAddress: "ledger@example.com", access: "free", visibility: "open",
    complianceFooter: "You subscribed at example.com", physicalAddress: "1 Main St, Springfield",
  };
  await stores.lists.put(list);
  const sub: Subscriber = {
    orgId: ORG, sub: "s1", email: "reader@x.com",
    attributes: { first_name: "Ada" }, status: "active", entitlement: "free",
  };
  await stores.subscribers.put(sub);
  const s: Subscription = {
    orgId: ORG, subscriberId: "s1", listId: LIST, status: "confirmed", updatedAt: "",
  };
  await stores.subscriptions.put(s);
  return stores;
}

async function smokeSend(template: { blocks?: unknown; html?: string }) {
  const stores = await seed();
  const sender = recordingSender();
  await sendCampaign(stores, sender, undefined, clock, {
    orgId: ORG, campaignId: "smoke", listId: LIST, subject: "Test send",
    template: template as never,
  }, { unsubscribeLink, segments: new GsiSegmentEngine(stores) });
  assert.equal(sender.sent.length, 1);
  return sender.sent[0]!;
}

// ---- what the seed must contain ----

test("the seed exercises every thing that can break silently", () => {
  // A template with no merge tag proves nothing about personalisation; one with
  // no link proves nothing about click tracking.
  for (const [mode, source] of [
    ["raw_html", primaryTestHtml],
    ["mjml", primaryTestMjml],
  ] as const) {
    assert.match(source, /\{\{first_name\}\}/, `${mode}: merge tag`);
    assert.match(source, /example\.com\/addressium\/smoke-test/, `${mode}: editorial link`);
    assert.match(source, /\{\{unsubscribe_url\}\}/, `${mode}: unsubscribe link`);
    assert.match(source, /\{\{list_name\}\}/, `${mode}: list name`);
  }
  const blocks = JSON.stringify(primaryTestBlocks);
  assert.match(blocks, /\{\{first_name\}\}/);
  assert.match(blocks, /\{\{unsubscribe_url\}\}/);
  assert.match(blocks, /smoke-test/);
});

test("the mjml source is stored as MJML, not as compiled output", () => {
  // "Does this MJML still compile?" is an acceptance criterion — storing the
  // compiled HTML would make it unanswerable from the stored template.
  assert.match(primaryTestSource("mjml"), /<mjml>/);
  assert.match(primaryTestSource("visual"), /<mjml>/, "the visual builder round-trips MJML");
  assert.match(primaryTestSource("raw_html"), /<!doctype html>/i);
  assert.doesNotMatch(primaryTestSource("raw_html"), /<mjml>/);
});

test("the editorial link points at example.com, not a real domain", () => {
  // A seed pointing at a live domain sends click traffic somewhere the operator
  // does not control, the first time anyone runs a smoke test.
  for (const source of [primaryTestHtml, primaryTestMjml, JSON.stringify(primaryTestBlocks)]) {
    const urls = source.match(/https?:\/\/[^"'\s<)]+/g) ?? [];
    for (const u of urls) {
      assert.match(u, /^https:\/\/example\.com\//, `points off-domain: ${u}`);
    }
  }
});

// ---- what a real send produces ----

test("a send from the seed has a working unsubscribe link and a text part", async () => {
  // The #204 acceptance criterion, and both halves used to fail.
  const msg = await smokeSend(primaryTestBlocks);
  assert.deepEqual(seedTemplateSmokeCheck(msg), []);
  assert.match(msg.html, /href="https:\/\/mail\.example\/u\?o=summit&amp;s=s1/);
  assert.ok(msg.text && msg.text.length > 0, "a text part must be present");
  assert.match(msg.text, /https:\/\/mail\.example\/u/, "the text part carries the unsubscribe URL");
});

test("`{{unsubscribe_url}}` used to render an empty href", async () => {
  // The exact regression: merge values came only from subscriber.attributes, and
  // no subscriber has an `unsubscribe_url` attribute.
  const msg = await smokeSend(primaryTestBlocks);
  assert.doesNotMatch(msg.html, /href=""/, "an empty unsubscribe href is a CAN-SPAM violation");
  assert.doesNotMatch(msg.html, /\{\{\s*unsubscribe_url\s*\}\}/, "and it must not render literally");
});

test("no merge tag survives into the recipient's inbox", async () => {
  const msg = await smokeSend(primaryTestBlocks);
  assert.doesNotMatch(msg.html, /\{\{[a-z0-9_]+\}\}/i);
  assert.match(msg.html, /Hello Ada/);
  assert.match(msg.html, /The Ledger/, "list_name resolves from the list, not an attribute");
});

test("the raw-HTML mode renders the same guarantees", async () => {
  // Comparing modes is the whole reason the seed exists — a difference has to
  // mean a renderer bug, not a typo in a fixture.
  const msg = await smokeSend({ html: primaryTestHtml });
  assert.deepEqual(seedTemplateSmokeCheck(msg), []);
  assert.doesNotMatch(msg.html, /\{\{[a-z0-9_]+\}\}/i);
});

test("a reserved merge name cannot be hijacked by a subscriber attribute", async () => {
  // An imported CSV column called `unsubscribe_url` must not be able to replace
  // the real one — that is a working-looking link that opts nobody out.
  const stores = await seed();
  await stores.subscribers.put({
    orgId: ORG, sub: "s1", email: "reader@x.com", status: "active", entitlement: "free",
    attributes: { first_name: "Ada", unsubscribe_url: "https://evil.example/not-really" },
  });
  const sender = recordingSender();
  await sendCampaign(stores, sender, undefined, clock, {
    orgId: ORG, campaignId: "smoke", listId: LIST, subject: "Test send", template: primaryTestBlocks,
  }, { unsubscribeLink, segments: new GsiSegmentEngine(stores) });
  assert.doesNotMatch(sender.sent[0]!.html, /evil\.example/);
  assert.match(sender.sent[0]!.html, /mail\.example\/u/);
});

test("the smoke check catches each failure it exists for", async () => {
  // A checker that only ever returns [] is not a check.
  assert.deepEqual(
    seedTemplateSmokeCheck({ html: "<p>Hi {{first_name}}</p>", text: "Hi" }).filter((p) => p.includes("merge")),
    ["unresolved merge tags: {{first_name}}"],
  );
  assert.ok(
    seedTemplateSmokeCheck({ html: '<a href="">Unsubscribe</a> https://x', text: "unsubscribe" })
      .some((p) => p.includes("no destination")),
  );
  assert.ok(
    seedTemplateSmokeCheck({ html: '<a href="https://u">Unsubscribe</a> https://x' })
      .some((p) => p.includes("no plain-text part")),
  );
});

// ---- the text part itself ----

test("the text part keeps link destinations, not just labels", () => {
  // A text reader with a bare "Unsubscribe" has no way to unsubscribe.
  const text = plainTextFrom('<p>Hi</p><p><a href="https://x.com/a">Read this</a></p>');
  assert.match(text, /Read this <https:\/\/x\.com\/a>/);
});

test("the text part drops script and style CONTENT, not just their tags", () => {
  // CSS and JS are not a text alternative; leaking them is how a text part ends
  // up as a wall of selectors.
  const text = plainTextFrom("<style>p{color:red}</style><script>alert(1)</script><p>Hello</p>");
  assert.equal(text, "Hello");
});

test("entities decode without re-introducing markup", () => {
  // `&amp;` must decode LAST: doing it first turns `&amp;lt;` — the correct
  // escaping of the literal text "&lt;" — back into a real `<`.
  assert.equal(plainTextFrom("<p>Tom &amp; Jerry</p>"), "Tom & Jerry");
  assert.equal(plainTextFrom("<p>&amp;lt;b&amp;gt;</p>"), "&lt;b&gt;");
});

test("an unterminated tag does not spill markup into the text part", () => {
  assert.equal(plainTextFrom("<p>Hello</p><a href=\"x"), "Hello");
});

test("a url identical to its label is not printed twice", () => {
  assert.equal(plainTextFrom('<a href="https://x.com">https://x.com</a>'), "https://x.com");
});

// ---- seeded at provisioning ----

const orgInput: schemas.CreateOrgInput = {
  name: "Northwind Times", primaryDomain: "northwindtimes.example",
  siteDomain: "northwindtimes.example", region: "us-east-1", defaultTimezone: "UTC",
  magicLinks: false, dedicatedIp: false, dmarcPolicy: "none",
    suppressionScope: "hybrid", environment: "prod",
};
const fakeProviders = (): ProvisioningProviders => ({
  linkSubscriberPool: async () => ({ poolId: "p" }),
  createSigningKey: async () => ({ kmsKeyArn: "arn", kid: "k" }),
  ensureSesDomainIdentity: async () => ({ configSet: "cs", dkimTokens: ["t"], verificationStatus: "pending" }),
});

test("every new org is provisioned with the seed in all three modes", async () => {
  // A fixture an operator has to paste is a fixture that drifts, and the first
  // thing anyone does with a new org is send a test.
  const stores = memStores();
  const { org } = await provisionOrganization(stores, fakeProviders(), orgInput);
  const templates = await stores.templates.list(org.orgId);
  const seeded = templates.filter((t) => t.templateId.startsWith(PRIMARY_TEST_TEMPLATE_ID));
  assert.deepEqual(seeded.map((t) => t.mode).sort(), ["mjml", "raw_html", "visual"]);
  for (const t of seeded) {
    assert.deepEqual([...t.mergeTags].sort(), ["first_name", "list_name", "unsubscribe_url"]);
    assert.equal(t.source, primaryTestSource(t.mode));
  }
});

test("re-provisioning does not clobber an edited seed", async () => {
  // Provisioning is idempotent on org id, and an operator who tuned the smoke
  // template should not find it reverted.
  const stores = memStores();
  const { org } = await provisionOrganization(stores, fakeProviders(), orgInput);
  const edited = (await stores.templates.get(org.orgId, PRIMARY_TEST_TEMPLATE_ID))!;
  await stores.templates.put({ ...edited, source: "<p>mine</p>", version: 2 });
  await provisionOrganization(stores, fakeProviders(), orgInput);
  assert.equal((await stores.templates.get(org.orgId, PRIMARY_TEST_TEMPLATE_ID))?.source, "<p>mine</p>");
});

test("clicking the seed's editorial link lands in the campaign click map", async () => {
  // The fourth acceptance criterion. The archive's link map is built from the
  // template at send time, so this also proves the seed's link is TRACKED rather
  // than merely present.
  const stores = await seed();
  await stores.campaigns.put({
    orgId: ORG, campaignId: "smoke", type: "one_off", subject: "Test send",
    templateId: PRIMARY_TEST_TEMPLATE_ID, audience: { listId: LIST }, status: "sent",
    counters: { sent: 1, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 },
  });
  const sender = recordingSender();
  await sendCampaign(stores, sender, undefined, clock, {
    orgId: ORG, campaignId: "smoke", listId: LIST, subject: "Test send", template: primaryTestBlocks,
  }, { unsubscribeLink, segments: new GsiSegmentEngine(stores) });

  const linkId = await recordClick(stores, clock, {
    orgId: ORG, campaignId: "smoke", subscriberId: "s1",
    clickedUrl: "https://example.com/addressium/smoke-test",
  });
  assert.ok(linkId, "the editorial link must resolve to a link id");

  const map = await buildClickMap(stores, ORG, "smoke");
  assert.equal(map.rows.find((r) => r.linkId === linkId)?.clicks, 1);
  assert.equal(map.rows.find((r) => r.linkId === linkId)?.label, "Read the test article");
});
