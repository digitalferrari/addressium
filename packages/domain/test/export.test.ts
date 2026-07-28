/**
 * Bulk export / portability (#224, compendium #58).
 *
 * The promise is "you can leave". The test that decides whether that is true is
 * the round trip: export → wipe → import must reproduce the list. An export
 * nobody can read back is a file, not portability.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { List } from "@addressium/core";
import {
  HmacConfirmationSigner,
  confirmOptIn,
  eraseSubscriber,
  exportCsv,
  exportCsvChunks,
  exportJsonl,
  exportJsonlChunks,
  exportRows,
  importWithMapping,
  memStores,
  previewCsv,
  signup,
  suggestMapping,
  type Clock,
  type Stores,
} from "@addressium/domain";

const ORG = "summit";
const NOW = new Date();
const clock: Clock = { now: () => NOW };
const signer = new HmacConfirmationSigner("s");

const list = (listId: string): List => ({
  orgId: ORG,
  listId,
  name: listId,
  optInPolicy: "double",
  fromAddress: "a@b.co",
  access: "free",
  visibility: "open",
  complianceFooter: "f",
  physicalAddress: "p",
});

/** Two confirmed subscribers on one list, with attributes and provenance. */
async function seeded(): Promise<Stores> {
  const stores = memStores();
  await stores.lists.put(list("ledger"));
  for (const [email, name] of [["alex@x.com", "Alex"], ["jordan@x.com", "Jordan, Jr."]]) {
    const r = await signup(
      stores,
      signer,
      clock,
      { orgId: ORG, email, listId: "ledger", attributes: { first_name: name! } },
      { sourceIp: "203.0.113.7", sourceUrl: "https://x.example/signup" },
    );
    await confirmOptIn(stores, signer, clock, r.confirmationToken, { sourceIp: "203.0.113.7" });
  }
  return stores;
}

test("the export carries consent provenance, not just addresses", async () => {
  const stores = await seeded();
  const rows = [];
  for await (const r of exportRows(stores, { orgId: ORG })) rows.push(r);

  assert.equal(rows.length, 2);
  const alex = rows.find((r) => r.email === "alex@x.com");
  assert.equal(alex?.subscriptionStatus, "confirmed");
  assert.ok(alex?.consentRequestedAt, "when they asked");
  assert.ok(alex?.consentConfirmedAt, "and when they confirmed — the evidence a dispute needs");
  assert.equal(alex?.consentBasis, "explicit");
  assert.equal(alex?.attributes["first_name"], "Alex");
});

test("CSV quotes values containing commas so a round trip survives them", async () => {
  const stores = await seeded();
  const csv = await exportCsv(stores, { orgId: ORG });

  assert.ok(csv.includes('"Jordan, Jr."'), "an attribute with a comma must be quoted");
  // Re-parsing with the importer's own parser is the real check.
  const back = previewCsv(csv);
  const jordan = back.sample.find((r) => r["email"] === "jordan@x.com");
  assert.equal(jordan?.["attr.first_name"], "Jordan, Jr.");
});

test("attributes become their own columns, not one opaque blob", async () => {
  const stores = await seeded();
  const header = previewCsv(await exportCsv(stores, { orgId: ORG })).headers;

  assert.ok(header.includes("attr.first_name"), "a JSON blob in one cell would not round-trip as attributes");
  assert.ok(header.includes("email"));
  assert.ok(header.includes("consentConfirmedAt"));
});

test("ROUND TRIP: export → wipe → import reproduces the list", async () => {
  const source = await seeded();
  const csv = await exportCsv(source, { orgId: ORG });

  // A clean org — as if migrating to a new deployment.
  const target = memStores();
  await target.lists.put(list("ledger"));

  const preview = previewCsv(csv);
  const plan = suggestMapping(preview, { knownLists: [{ listId: "ledger", name: "ledger" }] });
  // The exported `email` column maps itself; point the audience at the list.
  plan.columns["listId"] = { kind: "discard" };
  plan.columns["subscriptionStatus"] = { kind: "discard" };

  const report = await importWithMapping(target, clock, { orgId: ORG, csv, plan });

  assert.deepEqual(report.errors, [], "an export must import without hand-editing");
  assert.equal(report.created, 2, "both subscribers came back");

  const alex = await target.subscribers.findByEmail(ORG, "alex@x.com");
  assert.ok(alex, "addresses survive the trip");
  assert.equal(alex.attributes["first_name"], "Alex", "and so do attributes");
});

test("a suppressed address is exported as suppressed and never re-imported as mailable", async () => {
  const stores = await seeded();
  await stores.suppression.add({
    orgId: ORG,
    email: "alex@x.com",
    source: "complaint",
    scope: "org",
    addedAt: NOW.toISOString(),
  });

  const rows = [];
  for await (const r of exportRows(stores, { orgId: ORG })) rows.push(r);
  const alex = rows.find((r) => r.email === "alex@x.com");
  assert.equal(alex?.suppressed, true);
  assert.equal(alex?.suppressionSource, "complaint");

  // Re-importing that file must not resurrect them: importWithMapping consults
  // the suppression list itself, which is why suppression is exported as a fact
  // rather than replayed as a subscription.
  const csv = await exportCsv(stores, { orgId: ORG });
  const target = memStores();
  await target.lists.put(list("ledger"));
  await target.suppression.add({
    orgId: ORG,
    email: "alex@x.com",
    source: "complaint",
    scope: "org",
    addedAt: NOW.toISOString(),
  });
  const plan = suggestMapping(previewCsv(csv));
  const report = await importWithMapping(target, clock, { orgId: ORG, csv, plan });

  assert.equal(report.suppressed, 1);
  assert.equal(await target.subscribers.findByEmail(ORG, "alex@x.com"), undefined);
});

test("JSONL is one parseable object per line", async () => {
  const stores = await seeded();
  const jsonl = await exportJsonl(stores, { orgId: ORG });

  const lines = jsonl.trim().split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) {
    const o = JSON.parse(l) as Record<string, unknown>;
    assert.ok(typeof o["email"] === "string");
    // Lossless: attributes stay an object rather than being flattened.
    assert.equal(typeof o["attributes"], "object");
  }
});

test("unsubscribed rows are excluded by default and included on request", async () => {
  const stores = await seeded();
  const alex = await stores.subscribers.findByEmail(ORG, "alex@x.com");
  const sub = await stores.subscriptions.get(ORG, alex!.sub, "ledger");
  await stores.subscriptions.put({ ...sub!, status: "unsubscribed" });

  const without = [];
  for await (const r of exportRows(stores, { orgId: ORG })) without.push(r);
  assert.equal(without.length, 1);

  const withAll = [];
  for await (const r of exportRows(stores, { orgId: ORG, includeUnsubscribed: true })) withAll.push(r);
  assert.equal(withAll.length, 2, "an operator taking their data needs the opt-outs too");
});

test("an empty org exports a header and no rows, not a crash", async () => {
  const stores = memStores();
  const csv = await exportCsv(stores, { orgId: ORG });
  assert.ok(csv.startsWith("email,"));
  assert.equal(previewCsv(csv).rowCount, 0);
  assert.equal(await exportJsonl(stores, { orgId: ORG }), "");
});

test("listId narrows the export to one list", async () => {
  const stores = await seeded();
  await stores.lists.put(list("weekly"));
  const alex = await stores.subscribers.findByEmail(ORG, "alex@x.com");
  await stores.subscriptions.put({
    orgId: ORG,
    subscriberId: alex!.sub,
    listId: "weekly",
    status: "confirmed",
    updatedAt: NOW.toISOString(),
  });

  const rows = [];
  for await (const r of exportRows(stores, { orgId: ORG, listId: "weekly" })) rows.push(r);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.listId, "weekly");
});

/**
 * Streaming (#224, #182).
 *
 * The buffered forms are now conveniences over the chunk generators, and it is
 * the generators the export route uses. Two things must hold: the chunked and
 * buffered forms produce byte-identical output, and neither reads the whole
 * subscriber base into an array on the way.
 */
async function drain(chunks: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of chunks) out.push(c);
  return out;
}

test("chunked and buffered CSV are byte-identical", async () => {
  const stores = await seeded();
  const chunks = await drain(exportCsvChunks(stores, { orgId: ORG }));
  assert.equal(chunks.join(""), await exportCsv(stores, { orgId: ORG }));
  // One chunk per line, header first — so a writer can upload as it goes rather
  // than waiting for the whole file.
  assert.ok(chunks.length > 1);
  assert.ok(chunks[0]?.startsWith("email,"));
  assert.ok(chunks.every((c) => c.endsWith("\n")));
});

test("chunked and buffered JSONL are byte-identical", async () => {
  const stores = await seeded();
  const chunks = await drain(exportJsonlChunks(stores, { orgId: ORG }));
  assert.equal(chunks.join(""), await exportJsonl(stores, { orgId: ORG }));
  for (const c of chunks) JSON.parse(c); // every chunk is one complete record
});

test("the export never materializes the subscriber base", async () => {
  // `subscribers.list` returns one array of every subscriber in the org — the
  // Lambda OOM #182 is about, hit first by the largest org, which is the one
  // most likely to be leaving. The export path must use `stream` instead.
  const stores = await seeded();
  stores.subscribers.list = async () => {
    throw new Error("bulk export must not call subscribers.list");
  };
  const csvOut = await exportCsv(stores, { orgId: ORG });
  assert.ok(csvOut.includes("@"));
  assert.ok((await exportJsonl(stores, { orgId: ORG })).includes("@"));
});

test("an empty org exports a header and nothing else", async () => {
  // A zero-row export must still be a valid file — a re-import of it should be
  // a no-op, not a parse error.
  const stores = memStores();
  const chunks = await drain(exportCsvChunks(stores, { orgId: "nobody" }));
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]?.startsWith("email,"));
  assert.deepEqual(await drain(exportJsonlChunks(stores, { orgId: "nobody" })), []);
});

test("an erased subject's PII never appears in a later export", async () => {
  // The two features pull against each other: erasure removes personal data,
  // export copies everything out. If an export produced after an erasure still
  // carried the address, the erasure was undone by the next person who clicked
  // Export — and it would leave the account in a file the operator then mails
  // to a third party.
  const stores = await seeded();
  const before = await exportCsv(stores, { orgId: ORG, includeUnsubscribed: true });
  const victim = before.match(/([\w.]+@[\w.]+)/)?.[1];
  assert.ok(victim, "the fixture exports at least one real address");

  const erased = await eraseSubscriber(stores, clock, ORG, victim);
  assert.equal(erased, true);

  const after = await exportCsv(stores, { orgId: ORG, includeUnsubscribed: true });
  assert.ok(!after.includes(victim), `erased address still exported: ${victim}`);
  // The row itself survives as a tombstone — an erased subject who vanished
  // entirely would be re-added as fresh by the next import of an old file.
  assert.ok(after.includes("erased:"), "the anonymized placeholder is what remains");

  // Attributes are personal data too, and they are the half most likely to be
  // forgotten: an address can be spotted by eye in a CSV, a birthDate cannot.
  const jsonl = await exportJsonl(stores, { orgId: ORG, includeUnsubscribed: true });
  for (const line of jsonl.trim().split("\n")) {
    const row = JSON.parse(line) as { email: string; attributes: Record<string, string> };
    if (!row.email.startsWith("erased:")) continue;
    assert.deepEqual(row.attributes, {}, "an erased row must carry no attributes");
  }
});
