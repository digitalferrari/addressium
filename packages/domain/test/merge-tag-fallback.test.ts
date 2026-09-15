/**
 * The "fallback when empty" field, end to end (#266).
 *
 * The console has offered this field since the merge-tag registry shipped. The
 * value was schema-validated, persisted by `saveMergeTag`, returned by the API
 * and rendered in its own column on the Merge tags screen — and NOTHING read it.
 * `applyMerge` resolved a missing attribute to `""` unconditionally, never
 * consulting the registry, so an operator who set `there` as the fallback for
 * `{{first_name}}` saw it save, saw it in the table, and shipped a campaign that
 * greeted every attribute-less subscriber with "Hi ".
 *
 * That is worse than a dead button: the value round-trips, so it looks
 * confirmed.
 *
 * EVERY TEST HERE GOES THROUGH A REAL SEND and asserts on the captured message
 * body. The defect was a WIRING gap, not a logic error — a unit test of a
 * fallback-resolving helper would have passed against the broken code, because
 * the helper was never the thing missing. Only a test that renders through
 * `sendCampaign`/`sendToSubscriber` can fail when nothing calls it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "jose";
import type { List } from "@addressium/core";
import {
  memStores,
  CaptureSender,
  HmacConfirmationSigner,
  SystemClock,
  JoseMagicLinkSigner,
  signup,
  confirmOptIn,
  sendCampaign,
  sendToSubscriber,
  saveMergeTag,
  type EmailTemplate,
} from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";

const LIST_RECORD: List = {
  orgId: ORG,
  listId: LIST,
  name: "RealListName",
  optInPolicy: "double",
  fromAddress: "l@example.com",
  access: "free",
  visibility: "open",
  complianceFooter: "RealComplianceFooter",
  physicalAddress: "RealPhysicalAddress",
};

/** The template an operator writes when they configure a greeting fallback. */
const GREETING: EmailTemplate = { html: "<p>Hi [{{first_name}}]</p>" };

async function harness() {
  const stores = memStores();
  const sender = new CaptureSender();
  const clock = new SystemClock();
  const confirmSigner = new HmacConfirmationSigner("secret");
  const { privateKey } = await generateKeyPair("ES256");
  const magic = new JoseMagicLinkSigner(
    { privateKey, kid: "k1", issuer: "iss", audience: "aud", ttlSeconds: 3600 },
    clock,
  );
  await stores.lists.put(LIST_RECORD);
  return { stores, sender, clock, confirmSigner, magic };
}

/** Sign up and confirm one subscriber, then set their attributes verbatim. */
async function subscriber(
  h: Awaited<ReturnType<typeof harness>>,
  attributes: Record<string, string>,
): Promise<string> {
  const r = await signup(h.stores, h.confirmSigner, h.clock, {
    orgId: ORG,
    email: "reader@example.com",
    listId: LIST,
  });
  await confirmOptIn(h.stores, h.confirmSigner, h.clock, r.confirmationToken);
  const sub = (await h.stores.subscribers.get(ORG, r.subscriber.sub))!;
  await h.stores.subscribers.put({ ...sub, attributes });
  return r.subscriber.sub;
}

async function withFallback(h: Awaited<ReturnType<typeof harness>>, fallback: string) {
  await saveMergeTag(h.stores, {
    orgId: ORG,
    name: "first_name",
    source: "profile",
    scope: "per_recipient",
    example: "Jordan",
    fallback,
  });
}

test("a configured fallback renders when the attribute is ABSENT", async () => {
  const h = await harness();
  await withFallback(h, "there");
  await subscriber(h, {}); // no first_name at all

  await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "x",
    template: GREETING,
  });

  assert.equal(
    h.sender.sent[0]!.html,
    "<p>Hi [there]</p>",
    "the fallback the operator configured and saw in the table did not render — the field " +
      "round-trips and does nothing, which is how #266 looked",
  );
});

test("a configured fallback renders when the attribute is present but BLANK", async () => {
  const h = await harness();
  await withFallback(h, "there");
  // What a CSV import with an empty cell actually produces. Filtering only
  // `undefined` would leave this — the common case — rendering blank while the
  // operator saw a fallback configured.
  await subscriber(h, { first_name: "" });

  await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "x",
    template: GREETING,
  });

  assert.equal(h.sender.sent[0]!.html, "<p>Hi [there]</p>");
});

test("a real attribute still beats the fallback", async () => {
  const h = await harness();
  await withFallback(h, "there");
  await subscriber(h, { first_name: "Jordan" });

  await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "x",
    template: GREETING,
  });

  assert.equal(
    h.sender.sent[0]!.html,
    "<p>Hi [Jordan]</p>",
    "the fallback overrode a real value — every personalized send would say the same thing",
  );
});

test("no configured fallback still renders empty, not the literal placeholder", async () => {
  const h = await harness();
  await subscriber(h, {}); // registry has no first_name row at all

  await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "x",
    template: GREETING,
  });

  assert.equal(h.sender.sent[0]!.html, "<p>Hi []</p>");
});

test("a fallback is HTML-escaped like any other merge value", async () => {
  const h = await harness();
  // The fallback is operator-written, and it lands in the body through exactly
  // the same substitution as an attribute — so it must be escaped by exactly the
  // same code. A fallback that bypassed escaping would be a markup-injection
  // hole the attribute path does not have.
  await withFallback(h, "<b>friend</b>&co");
  await subscriber(h, {});

  await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "x",
    template: GREETING,
  });

  assert.equal(h.sender.sent[0]!.html, "<p>Hi [&lt;b&gt;friend&lt;/b&gt;&amp;co]</p>");
});

test("the drip / transactional path honors the fallback too", async () => {
  // sendToSubscriber is a second, independent render call site. Wiring the
  // campaign path alone would leave every drip step and transactional message
  // still rendering blank, with the console showing the same configured value.
  const h = await harness();
  await withFallback(h, "there");
  const sub = await subscriber(h, {});

  const r = await sendToSubscriber(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "drip-step-1",
    subscriberId: sub,
    listId: LIST,
    subject: "x",
    template: GREETING,
  });

  assert.equal(r.sent, true);
  assert.equal(h.sender.sent[0]!.html, "<p>Hi [there]</p>");
});

test("a reserved name still wins over a stored fallback row", async () => {
  // `saveMergeTag` refuses a reserved name, but a row can exist from before it
  // did. Such a row must not put an operator-chosen string where the send path's
  // own value belongs — least of all in the unsubscribe link.
  const h = await harness();
  await h.stores.mergeTags.put({
    orgId: ORG,
    name: "unsubscribe_url",
    source: "system",
    scope: "per_recipient",
    fallback: "https://attacker.example/hijack",
  });
  await subscriber(h, {});

  await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "x",
    template: { html: "<p>u=[{{unsubscribe_url}}]</p>" },
  });

  const html = h.sender.sent[0]!.html;
  assert.doesNotMatch(
    html,
    /attacker\.example/,
    "a stored fallback replaced the real unsubscribe link — the one link a recipient is " +
      "legally entitled to",
  );
  assert.match(html, /u=\[[^\]]+\]/, "and the real value still rendered");
});
