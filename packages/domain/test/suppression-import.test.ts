/**
 * Importing a provider's account suppression list (#240).
 *
 * The migration gap that actively causes harm rather than losing data: subscriber
 * records can be re-exported from the source at any time, but "SES already knows
 * this address hard-bounces" exists only in the account suppression list. Import
 * the endpoints without it and the first campaign mails every one of them —
 * straight into the bounce and complaint rates the deliverability halt exists to
 * catch, on day one, in front of somebody deciding whether to trust this.
 *
 * So the load-bearing assertion here is not the reason mapping — it is the last
 * test, which sends a real campaign and proves the imported address is skipped.
 * A suppression import that writes rows the send path does not consult would pass
 * every other test in this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CaptureSender,
  importSuppressionList,
  memStores,
  sendCampaign,
  type Clock,
  type EmailTemplate,
  type Stores,
  type SuppressedDestination,
  type SuppressionListReader,
} from "@addressium/domain";
import type { SuppressionEntry } from "@addressium/core";

const ORG = "summit";
const LIST = "ledger";
const NOW = "2026-07-30T12:00:00.000Z";
const clock: Clock = { now: () => new Date(NOW) };

/** A reader over a fixed page set, so pagination is the adapter's problem not this one's. */
const readerOf = (...entries: SuppressedDestination[]): SuppressionListReader => ({
  list: async function* () {
    for (const e of entries) yield e;
  },
});

const bounce = (email: string, at?: string): SuppressedDestination => ({
  email,
  reason: "BOUNCE",
  ...(at ? { at } : {}),
});

test("SES reasons map to the sources and the GLOBAL scope a live bounce would use", async () => {
  const stores = memStores();
  const report = await importSuppressionList(
    stores,
    clock,
    readerOf(bounce("hard@example.com"), { email: "angry@example.com", reason: "COMPLAINT" }),
    { orgId: ORG },
  );

  assert.equal(report.read, 2);
  assert.equal(report.written, 2);
  assert.deepEqual(report.bySource, { bounce: 1, complaint: 1 });

  const [hard] = await stores.suppression.entriesFor(ORG, "hard@example.com");
  assert.equal(hard?.source, "bounce");
  // Global, not org: these threaten the sending reputation every org in the
  // deployment shares, so an org-scoped entry would let a second org mail an
  // address the account already knows is toxic (§4.13).
  assert.equal(hard?.scope, "global");
  const [angry] = await stores.suppression.entriesFor(ORG, "angry@example.com");
  assert.equal(angry?.source, "complaint");
  assert.equal(angry?.scope, "global");
});

test("an unrecognized reason is reported, never guessed into a suppression", async () => {
  const stores = memStores();
  const report = await importSuppressionList(
    stores,
    clock,
    readerOf(bounce("hard@example.com"), { email: "who@example.com", reason: "SOME_FUTURE_REASON" }),
    { orgId: ORG },
  );

  assert.equal(report.read, 2);
  assert.equal(report.written, 1);
  assert.deepEqual(report.unmapped, [{ email: "who@example.com", reason: "SOME_FUTURE_REASON" }]);
  // The point of refusing to guess: a permanent GLOBAL suppression invented from
  // a value nobody has read is not recoverable in bulk.
  assert.equal(await stores.suppression.isSuppressed(ORG, "who@example.com"), false);
});

test("the provider's timestamp is kept, because it is the evidence", async () => {
  const stores = memStores();
  await importSuppressionList(
    stores,
    clock,
    readerOf(bounce("old@example.com", "2023-01-02T03:04:05.000Z"), bounce("undated@example.com")),
    { orgId: ORG },
  );

  const [old] = await stores.suppression.entriesFor(ORG, "old@example.com");
  // Stamping this with the import date would destroy the answer to "why is this
  // address suppressed" — "SES recorded a hard bounce in 2023" is the answer.
  assert.equal(old?.addedAt, "2023-01-02T03:04:05.000Z");
  const [undated] = await stores.suppression.entriesFor(ORG, "undated@example.com");
  assert.equal(undated?.addedAt, NOW, "falls back to now only when the provider is silent");
});

test("addresses are normalized and unusable ones are counted, not written", async () => {
  const stores = memStores();
  const report = await importSuppressionList(
    stores,
    clock,
    readerOf(
      bounce("  MiXeD@Example.COM  "),
      bounce(""),
      bounce("no-at-sign"),
      bounce("two@at@signs.com"),
      bounce("has space@example.com"),
    ),
    { orgId: ORG },
  );

  assert.equal(report.written, 1);
  assert.equal(report.malformed, 4);
  // Lower-cased and trimmed because that is the form `isSuppressed` looks up — a
  // mixed-case address written raw would be invisible to the gate that matters.
  assert.equal(await stores.suppression.isSuppressed(ORG, "mixed@example.com"), true);
});

test("the write path batches — it does not issue one call per address", async () => {
  const stores = memStores();
  const batchSizes: number[] = [];
  let singleAdds = 0;
  const counting: Stores = {
    ...stores,
    suppression: {
      ...stores.suppression,
      add: async (e: SuppressionEntry) => {
        singleAdds++;
        return stores.suppression.add(e);
      },
      addMany: async (entries: SuppressionEntry[]) => {
        batchSizes.push(entries.length);
        return stores.suppression.addMany(entries);
      },
    },
  };

  const many = Array.from({ length: 1201 }, (_, i) => bounce(`b${i}@example.com`));
  const report = await importSuppressionList(counting, clock, readerOf(...many), { orgId: ORG });

  assert.equal(report.written, 1201);
  // A real account list is years of accumulated bounces. One round trip each is
  // slow enough that an operator abandons it half-done — and half-done is the
  // dangerous state: subscribers imported, only some suppressions applied.
  assert.equal(singleAdds, 0, "no per-address writes");
  assert.deepEqual(batchSizes, [500, 500, 201]);
  assert.equal(await stores.suppression.isSuppressed(ORG, "b1200@example.com"), true);
});

test("a duplicated address is tolerated rather than fatal", async () => {
  const stores = memStores();
  // A provider paginates, and a page boundary can repeat an entry under
  // concurrent modification. DynamoDB rejects a whole batch containing duplicate
  // keys, so the store dedupes — the importer must not have to.
  const report = await importSuppressionList(
    stores,
    clock,
    readerOf(bounce("dup@example.com"), bounce("DUP@example.com")),
    { orgId: ORG },
  );
  assert.equal(report.read, 2);
  assert.equal(await stores.suppression.isSuppressed(ORG, "dup@example.com"), true);
  assert.equal((await stores.suppression.entriesFor(ORG, "dup@example.com")).length, 1);
});

test("a dry run reports exactly what a real run would write, and writes none of it", async () => {
  const stores = memStores();
  const entries = [bounce("a@example.com"), { email: "b@example.com", reason: "COMPLAINT" }];
  const dry = await importSuppressionList(stores, clock, readerOf(...entries), {
    orgId: ORG,
    dryRun: true,
  });

  assert.equal(dry.written, 2);
  assert.equal(await stores.suppression.isSuppressed(ORG, "a@example.com"), false);

  // These entries are GLOBAL and there is no bulk un-suppress, so pointing this
  // at the wrong account has no cheap way back. The dry run has to agree with the
  // real one or it is not worth having.
  const wet = await importSuppressionList(stores, clock, readerOf(...entries), { orgId: ORG });
  assert.deepEqual({ ...wet }, { ...dry });
  assert.equal(await stores.suppression.isSuppressed(ORG, "a@example.com"), true);
});

test("an imported address is skipped by the next campaign", async () => {
  const stores = memStores();
  await stores.lists.put({
    orgId: ORG,
    listId: LIST,
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "editor@summit.example",
    access: "free",
    visibility: "open",
    complianceFooter: "footer",
    physicalAddress: "1 Road",
  });
  const people: [string, string][] = [
    ["sub-clean", "clean@example.com"],
    ["sub-bounced", "hard@example.com"],
  ];
  for (const [sub, email] of people) {
    await stores.subscribers.put({
      orgId: ORG,
      sub,
      email,
      attributes: {},
      status: "active",
      entitlement: "free",
    });
    await stores.subscriptions.put({
      orgId: ORG,
      subscriberId: sub,
      listId: LIST,
      status: "confirmed",
      updatedAt: NOW,
    });
  }

  await importSuppressionList(stores, clock, readerOf(bounce("hard@example.com")), { orgId: ORG });

  // The whole reason this feature exists. Note the subscriber is still `active`
  // and their subscription still `confirmed` — the import writes suppression rows
  // and does not walk subscribers (it cannot: at migration time the endpoints are
  // usually not imported yet). So this asserts the gate the send path ACTUALLY
  // consults, which is `isSuppressed`, not a subscriber flag.
  const sender = new CaptureSender();
  const template: EmailTemplate = { html: "<p>hello</p>" };
  await sendCampaign(stores, sender, undefined, clock, {
    orgId: ORG,
    campaignId: "first-after-migration",
    listId: LIST,
    subject: "Issue 1",
    template,
  });

  const to = sender.sent.map((m) => m.to).sort();
  assert.deepEqual(to, ["clean@example.com"]);
  assert.equal(
    (await stores.subscribers.get(ORG, "sub-bounced"))?.status,
    "active",
    "the entry alone is what blocks the send",
  );
});
