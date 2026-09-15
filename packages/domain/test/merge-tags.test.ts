/**
 * The merge-tag registry (§4.15) and the precedence rule it exists to make real.
 *
 * The rule: a RESERVED name — one the send path supplies — beats a subscriber
 * attribute of the same name, always. `subscriber.attributes` is written by
 * whoever uploads a CSV, so if an attribute could win, an imported column called
 * `unsubscribe_url` would replace the one link a recipient is legally entitled
 * to with a link of the importer's choosing, and the message would look entirely
 * correct while doing it.
 *
 * `seed-template.test.ts` already covers that for `unsubscribe_url` specifically.
 * What is tested here is the part that keeps the guarantee from rotting: the
 * precedence holds for EVERY name in `RESERVED_MERGE_TAGS`, driven off the
 * constant rather than a hand-written list, so adding a fifth reserved name
 * cannot ship with only three-quarters of the protection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "jose";
import type { List } from "@addressium/core";
import { RESERVED_MERGE_TAGS, isReservedMergeTag } from "@addressium/core";
import {
  memStores,
  CaptureSender,
  HmacConfirmationSigner,
  SystemClock,
  JoseMagicLinkSigner,
  signup,
  confirmOptIn,
  sendCampaign,
  listMergeTags,
  saveMergeTag,
  deleteMergeTag,
  InvalidInputError,
  type EmailTemplate,
} from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";

/** Distinct, recognizable values so a test can tell WHICH source a rendered value came from. */
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

/**
 * A template that renders every reserved name, built from the constant.
 *
 * Deliberately generated rather than written out: a hand-written template is
 * exactly the thing that would keep passing after a fifth reserved name is
 * added, because nobody would remember to add the placeholder to it.
 */
const reservedTemplate: EmailTemplate = {
  html: RESERVED_MERGE_TAGS.map((t) => `<p>${t.name}=[{{${t.name}}}]</p>`).join("\n"),
};

/** The value a hostile import would try to smuggle in under a reserved name. */
const HIJACK = "HIJACKED-BY-ATTRIBUTE";

test("every reserved merge tag resolves at send time — none renders empty or literal", async () => {
  const h = await harness();
  const r = await signup(h.stores, h.confirmSigner, h.clock, {
    orgId: ORG,
    email: "reader@example.com",
    listId: LIST,
  });
  await confirmOptIn(h.stores, h.confirmSigner, h.clock, r.confirmationToken);

  await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "x",
    template: reservedTemplate,
  });

  const html = h.sender.sent[0]!.html;
  for (const tag of RESERVED_MERGE_TAGS) {
    // Not left as a literal `{{name}}` — the send path knows this name.
    assert.doesNotMatch(
      html,
      new RegExp(`\\{\\{\\s*${tag.name}\\s*\\}\\}`),
      `${tag.name} rendered literally: it is listed as reserved but nothing resolves it`,
    );
    // And not resolved to the empty string, which is how the #204 bug looked.
    assert.doesNotMatch(
      html,
      new RegExp(`${tag.name}=\\[\\]`),
      `${tag.name} resolved to empty — a merge tag that renders blank looks correct in preview`,
    );
  }
});

test("a reserved name beats a subscriber attribute of the same name — for EVERY reserved name", async () => {
  const h = await harness();
  const r = await signup(h.stores, h.confirmSigner, h.clock, {
    orgId: ORG,
    email: "reader@example.com",
    listId: LIST,
  });
  await confirmOptIn(h.stores, h.confirmSigner, h.clock, r.confirmationToken);

  // The hostile import: one attribute per reserved name, all of them trying to win.
  const sub = (await h.stores.subscribers.get(ORG, r.subscriber.sub))!;
  await h.stores.subscribers.put({
    ...sub,
    attributes: Object.fromEntries(RESERVED_MERGE_TAGS.map((t) => [t.name, HIJACK])),
  });

  await sendCampaign(h.stores, h.sender, h.magic, h.clock, {
    orgId: ORG,
    campaignId: "c1",
    listId: LIST,
    subject: "x",
    template: reservedTemplate,
  });

  const html = h.sender.sent[0]!.html;
  assert.doesNotMatch(
    html,
    new RegExp(HIJACK),
    "a subscriber attribute overrode a reserved merge value — an imported CSV column can now " +
      "replace the unsubscribe link, the list name, or the CAN-SPAM footer",
  );
  // And the real values are what landed, per name, so this cannot pass by
  // rendering nothing at all.
  assert.match(html, /list_name=\[RealListName\]/);
  assert.match(html, /compliance_footer=\[RealComplianceFooter\]/);
  assert.match(html, /physical_address=\[RealPhysicalAddress\]/);
  assert.match(html, /unsubscribe_url=\[[^\]]+\]/);
});

test("the registry lists every reserved tag, flagged, even for an org with none of its own", async () => {
  const stores = memStores();
  const rows = await listMergeTags(stores, ORG);
  assert.deepEqual(
    rows.map((t) => t.name),
    RESERVED_MERGE_TAGS.map((t) => t.name),
  );
  assert.ok(rows.every((t) => t.reserved), "reserved tags must be flagged so the UI cannot edit them");
  assert.ok(rows.every((t) => t.orgId === ORG), "rows are stamped with the org that asked");
});

test("org-defined tags are listed after the reserved ones, unflagged and sorted", async () => {
  const stores = memStores();
  await saveMergeTag(stores, {
    orgId: ORG,
    name: "first_name",
    source: "profile",
    scope: "per_recipient",
    example: "Jordan",
    fallback: "there",
  });
  await saveMergeTag(stores, {
    orgId: ORG,
    name: "article_title",
    source: "feed",
    scope: "per_campaign",
  });

  const rows = await listMergeTags(stores, ORG);
  const own = rows.filter((t) => !t.reserved);
  assert.deepEqual(own.map((t) => t.name), ["article_title", "first_name"]);
  assert.equal(own[1]!.fallback, "there");
  // Reserved come first, so the screen reads top-down as "what you cannot change,
  // then what you can".
  assert.ok(rows.slice(0, RESERVED_MERGE_TAGS.length).every((t) => t.reserved));
});

test("registering a reserved name is refused with a sentence the operator can act on", async () => {
  const stores = memStores();
  for (const tag of RESERVED_MERGE_TAGS) {
    await assert.rejects(
      () =>
        saveMergeTag(stores, {
          orgId: ORG,
          name: tag.name,
          source: "profile",
          scope: "per_recipient",
        }),
      (e: unknown) => {
        // InvalidInputError, not a bare Error: `fail()` classifies by TYPE, and a
        // bare Error would reach the operator as a generic 500 (#265).
        assert.ok(e instanceof InvalidInputError, `${tag.name} must be refused as InvalidInputError`);
        assert.match((e as Error).message, new RegExp(tag.name), "the message must name the tag");
        assert.match((e as Error).message, /reserved/i);
        return true;
      },
      `${tag.name} was accepted — the console would show a tag that never renders`,
    );
  }
  // Nothing was written by the refused attempts.
  assert.equal((await stores.mergeTags.list(ORG)).length, 0);
});

test("a stored tag colliding with a reserved name is dropped from the registry, not shown twice", async () => {
  // Such a row can exist from before the name was reserved. Showing both would
  // give an operator two rows for one `{{…}}` with no way to tell which wins.
  const stores = memStores();
  await stores.mergeTags.put({
    orgId: ORG,
    name: "unsubscribe_url",
    source: "profile",
    scope: "per_recipient",
    example: "https://evil.example/not-really",
  });

  const rows = await listMergeTags(stores, ORG);
  const matches = rows.filter((t) => t.name === "unsubscribe_url");
  assert.equal(matches.length, 1, "exactly one row per merge name");
  assert.ok(matches[0]!.reserved, "and it is the reserved one");
  assert.notEqual(matches[0]!.example, "https://evil.example/not-really");
});

test("deleting a reserved tag is refused; deleting an org-defined one works", async () => {
  const stores = memStores();
  await saveMergeTag(stores, {
    orgId: ORG,
    name: "first_name",
    source: "profile",
    scope: "per_recipient",
  });
  await assert.rejects(
    () => deleteMergeTag(stores, ORG, "unsubscribe_url"),
    InvalidInputError,
  );
  await deleteMergeTag(stores, ORG, "first_name");
  assert.equal(await stores.mergeTags.get(ORG, "first_name"), undefined);
});

test("the registry is org-scoped", async () => {
  const stores = memStores();
  await saveMergeTag(stores, {
    orgId: ORG,
    name: "first_name",
    source: "profile",
    scope: "per_recipient",
  });
  const other = (await listMergeTags(stores, "someone-else")).filter((t) => !t.reserved);
  assert.deepEqual(other, []);
});

test("isReservedMergeTag agrees with the constant", () => {
  for (const tag of RESERVED_MERGE_TAGS) assert.ok(isReservedMergeTag(tag.name));
  assert.equal(isReservedMergeTag("first_name"), false);
  assert.equal(isReservedMergeTag(""), false);
});
