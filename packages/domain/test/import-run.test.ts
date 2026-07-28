/**
 * Applying a validated import mapping (#216) — the write path.
 *
 * These assert the three rules that keep an import compliant: a non-mailable
 * row is kept but never subscribed, a decline is persisted rather than dropped,
 * and "never asked" writes nothing at all.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { previewCsv, suggestMapping, type MappingPlan } from "../src/import-mapping.js";
import {
  columnsBlockingConfirmed,
  importWithMapping,
  statusFor,
  type NewListDefaults,
} from "../src/import-run.js";
import { memStores } from "../src/memory.js";
import type { Clock } from "../src/ports.js";

/** Fixed clock — a deterministic updatedAt keeps these assertions stable. */
const clock: Clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };

const ORG = "summit";
// Resolved from the COMPILED location (dist/test/), because tsc does not
// copy non-TS assets — so this walks back to the source tree.
const FIXTURE = fileURLToPath(new URL("../../test/fixtures/pinpoint-export.csv", import.meta.url));
const csv = (): string => readFileSync(FIXTURE, "utf8");

const DEFAULTS: NewListDefaults = {
  fromAddress: "news@summitdaily.test",
  complianceFooter: "You are receiving this because you subscribed.",
  physicalAddress: "1 Main St, Frisco CO",
};

const planFor = (text: string): MappingPlan => suggestMapping(previewCsv(text));

test("a full Pinpoint export imports through the suggested mapping", async () => {
  const stores = memStores();
  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
  });

  // 8 fixture rows: 6 importable, plus two rejected — the blank address and the
  // SMS endpoint, whose phone number is not an address.
  assert.equal(report.errors.length, 2, `unexpected errors: ${report.errors.join(" | ")}`);
  assert.equal(report.created, 6);

  // Errors cite the file's own line number so a bad row is findable in a large
  // upload; a counter-derived number would repeat itself.
  assert.ok(report.errors.some((e) => e.startsWith("line 7:")), report.errors.join(" | "));
  assert.ok(report.errors.some((e) => e.startsWith("line 8:")), report.errors.join(" | "));
  assert.ok(report.errors.some((e) => e.includes("not an email endpoint (ChannelType=SMS)")));
  assert.ok(report.listsCreated.length > 0);
  assert.ok(report.discardedCells > 0, "discarded cells are counted, never silent");
});

test("OptOut: ALL is imported as a record but gets no active subscription", async () => {
  const stores = memStores();
  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
  });

  const jordan = await stores.subscribers.findByEmail(ORG, "jordan.lee@example.com");
  assert.ok(jordan, "the opted-out row must still be kept — dropping it loses the opt-out itself");

  const subs = await stores.subscriptions.listBySubscriber(ORG, jordan.sub);
  assert.equal(
    subs.filter((s) => s.status === "pending" || s.status === "confirmed").length,
    0,
    "row-level opt-out outranks the per-list true flag",
  );
});

test("EndpointStatus: INACTIVE gets no active subscription despite two true columns", async () => {
  const stores = memStores();
  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
  });

  const sam = await stores.subscribers.findByEmail(ORG, "sam.patel@example.com");
  assert.ok(sam);
  const subs = await stores.subscriptions.listBySubscriber(ORG, sam.sub);
  assert.equal(subs.filter((s) => s.status !== "unsubscribed").length, 0);
});

test("an all-empty row creates the subscriber and NOTHING else", async () => {
  const stores = memStores();
  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
  });

  const morgan = await stores.subscribers.findByEmail(ORG, "morgan.diaz@example.com");
  assert.ok(morgan);
  const subs = await stores.subscriptions.listBySubscriber(ORG, morgan.sub);
  assert.equal(subs.length, 0, "never asked is not a decline — it must write no subscription row");
});

test("an explicit decline is persisted as unsubscribed, not dropped", async () => {
  const stores = memStores();
  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
  });

  const alex = await stores.subscribers.findByEmail(ORG, "alex.rivera@example.com");
  assert.ok(alex);
  const subs = await stores.subscriptions.listBySubscriber(ORG, alex.sub);
  // A "no" we fail to record is a "no" the next import will not know about.
  assert.ok(subs.filter((s) => s.status === "unsubscribed").length >= 8);
  assert.equal(subs.filter((s) => s.status === "pending").length, 1);
});

test("imported subscriptions default to pending, never confirmed (#192)", async () => {
  const stores = memStores();
  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
  });
  const alex = await stores.subscribers.findByEmail(ORG, "alex.rivera@example.com");
  const subs = await stores.subscriptions.listBySubscriber(ORG, alex!.sub);
  assert.equal(subs.filter((s) => s.status === "confirmed").length, 0);
});

test("a suppressed address is never resurrected by an upload", async () => {
  const stores = memStores();
  await stores.suppression.add({
    orgId: ORG,
    email: "alex.rivera@example.com",
    source: "complaint",
    scope: "org",
    addedAt: new Date().toISOString(),
  });

  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
  });

  assert.equal(report.suppressed, 1);
  assert.equal(await stores.subscribers.findByEmail(ORG, "alex.rivera@example.com"), undefined);
});

test("creating a list without compliance defaults is refused, and nothing is written", async () => {
  const stores = memStores();
  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    // no newListDefaults
  });

  assert.ok(report.errors.some((e) => e.includes("no newListDefaults")));
  assert.equal(report.created, 0);
  assert.deepEqual(await stores.lists.list(ORG), [], "a list needs a real from-address and footer");
});

test("an invalid plan is rejected before any row is written", async () => {
  const stores = memStores();
  const text = ["email,name", "a@x.com,Ann"].join("\n");
  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: text,
    plan: { columns: { email: { kind: "discard" }, name: { kind: "discard" } } },
  });

  assert.ok(report.errors.some((e) => e.includes("no column is mapped to the email address")));
  assert.equal(report.created, 0);
  assert.equal(await stores.subscribers.findByEmail(ORG, "a@x.com"), undefined);
});

test("dryRun reports counts and writes nothing", async () => {
  const stores = memStores();
  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
    dryRun: true,
  });

  assert.equal(report.created, 6);
  assert.ok(report.subscriptionsCreated > 0);
  assert.equal(await stores.subscribers.findByEmail(ORG, "alex.rivera@example.com"), undefined);
  assert.deepEqual(await stores.lists.list(ORG), []);
});

test("an existing list with the same name is reused, not duplicated", async () => {
  const stores = memStores();
  await stores.lists.put({
    orgId: ORG,
    listId: "lst_existing",
    name: "SD_Skiing",
    optInPolicy: "double",
    fromAddress: "ski@summitdaily.test",
    access: "free",
    visibility: "open",
    complianceFooter: "footer",
    physicalAddress: "addr",
  });

  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
  });

  assert.ok(!report.listsCreated.includes("imp_sd-skiing"));
  assert.equal((await stores.lists.list(ORG)).filter((l) => l.name === "SD_Skiing").length, 1);
});

test("re-importing the same file does not duplicate lists or subscribers", async () => {
  const stores = memStores();
  const run = async () =>
    importWithMapping(stores, clock, {
      orgId: ORG,
      csv: csv(),
      plan: planFor(csv()),
      newListDefaults: DEFAULTS,
    });

  const first = await run();
  const second = await run();

  assert.equal(first.created, 6);
  assert.equal(second.created, 0, "second pass updates rather than creates");
  assert.equal(second.updated, 6);
  const names = (await stores.lists.list(ORG)).map((l) => l.name);
  assert.equal(new Set(names).size, names.length, "list ids are deterministic, so no duplicates");
});

test("duplicate addresses within one file are counted once", async () => {
  const stores = memStores();
  const text = ["email,name", "A@X.com,Ann", "a@x.com,Dupe"].join("\n");
  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: text,
    plan: planFor(text),
  });

  assert.equal(report.created, 1);
  assert.equal(report.duplicates, 1);
});

test("an implicit basis can only ever produce pending, even when confirmed is requested", async () => {
  const stores = memStores();
  const plan = suggestMapping(previewCsv(csv()), { consentBasis: "implicit" });
  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan,
    newListDefaults: DEFAULTS,
    status: "confirmed", // an operator asking to skip double opt-in
  });

  const alex = await stores.subscribers.findByEmail(ORG, "alex.rivera@example.com");
  const subs = await stores.subscriptions.listBySubscriber(ORG, alex!.sub);
  // An existing relationship is not proof of opt-in. Honouring `confirmed` here
  // would mail a list that never opted in (#223).
  assert.equal(subs.filter((s) => s.status === "confirmed").length, 0);
  assert.ok(subs.some((s) => s.status === "pending"));
});

test("an explicit basis honours the caller's requested status", async () => {
  const stores = memStores();
  const plan = suggestMapping(previewCsv(csv()), { consentBasis: "explicit" });
  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan,
    newListDefaults: DEFAULTS,
    status: "confirmed",
  });

  const alex = await stores.subscribers.findByEmail(ORG, "alex.rivera@example.com");
  const subs = await stores.subscriptions.listBySubscriber(ORG, alex!.sub);
  assert.ok(subs.some((s) => s.status === "confirmed"), "the file carries double opt-in evidence");
});

test("every imported subscription records its basis and batch", async () => {
  const stores = memStores();
  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: suggestMapping(previewCsv(csv()), { consentBasis: "implicit" }),
    newListDefaults: DEFAULTS,
    batchId: "batch-2026-07-28-a",
    sourceFile: "pinpoint-export.csv",
  });

  const alex = await stores.subscribers.findByEmail(ORG, "alex.rivera@example.com");
  const subs = await stores.subscriptions.listBySubscriber(ORG, alex!.sub);
  const subscribed = subs.find((s) => s.status === "pending");

  // The same field a double-opt-in signup writes (#220), so one lookup answers
  // provenance whether the row came from a form or a file.
  assert.equal(subscribed?.consent?.basis, "implicit");
  assert.equal(subscribed?.consent?.importBatchId, "batch-2026-07-28-a");
  assert.equal(subscribed?.consent?.sourceUrl, "pinpoint-export.csv");
  assert.ok(subscribed?.consent?.requestedAt);
  assert.equal(subscribed?.consent?.confirmedAt, undefined, "an import proves nothing about confirmation");
});

test("statusFor is the whole rule, and it fails closed on an unknown basis", () => {
  assert.equal(statusFor("explicit", "confirmed"), "confirmed");
  assert.equal(statusFor("explicit", undefined), "pending");
  assert.equal(statusFor("implicit", "confirmed"), "pending");
  assert.equal(statusFor(undefined, "confirmed"), "pending", "no declared basis is not explicit");
});

/**
 * Batch enumeration (#223).
 *
 * `consent.importBatchId` already recorded which run wrote a subscription, but
 * answering the question that actually matters — "what did that bad file do?" —
 * meant reading every subscription in the org. These cover the index that makes
 * a run enumerable, and the counts an operator compares before reversing one.
 */
test("an import records a batch whose rows can be listed afterwards", async () => {
  const stores = memStores();
  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
    batchId: "batch-a",
    sourceFile: "pinpoint-export.csv",
  });

  const batch = await stores.importBatches.get(ORG, "batch-a");
  assert.ok(batch, "the run left a record");
  assert.equal(batch.sourceFile, "pinpoint-export.csv");
  assert.equal(batch.created, report.created);
  assert.equal(batch.updated, report.updated);
  assert.equal(batch.subscriptionsCreated, report.subscriptionsCreated);

  const rows = await stores.importBatches.listRows(ORG, "batch-a");
  // rowCount is memberships, not file lines — the same measurement listRows
  // returns, so the two numbers an operator compares are comparable.
  assert.equal(rows.length, batch.rowCount);
  assert.equal(rows.length, report.subscriptionsCreated + report.declinesRecorded);

  // Every pointer resolves to a subscription that names this batch.
  for (const r of rows) {
    const s = await stores.subscriptions.get(ORG, r.subscriberId, r.listId);
    assert.equal(s?.consent?.importBatchId, "batch-a", `${r.subscriberId}/${r.listId}`);
  }
});

test("declines are enumerable too — reversing a batch must undo them as well", async () => {
  const stores = memStores();
  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
    batchId: "batch-b",
  });
  assert.ok(report.declinesRecorded > 0, "the fixture carries at least one explicit no");

  const rows = await stores.importBatches.listRows(ORG, "batch-b");
  const statuses = await Promise.all(
    rows.map(async (r) => (await stores.subscriptions.get(ORG, r.subscriberId, r.listId))?.status),
  );
  assert.ok(statuses.includes("unsubscribed"), "a decline is indexed, not just the opt-ins");
});

test("the batch record exists before the rows do, so a run that dies is still findable", async () => {
  // Written up front rather than on success: a half-finished import is exactly
  // the one someone needs to find, and a record written only at the end would be
  // missing for precisely those runs.
  const stores = memStores();
  const seen: string[] = [];
  const realPut = stores.subscribers.put.bind(stores.subscribers);
  stores.subscribers.put = async (s) => {
    const b = await stores.importBatches.get(ORG, "batch-c");
    seen.push(b ? "batch-first" : "row-first");
    return realPut(s);
  };

  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
    batchId: "batch-c",
  });
  assert.ok(seen.length > 0);
  assert.ok(!seen.includes("row-first"), "the batch record predates every write it accounts for");
});

test("a dry run leaves no batch behind", async () => {
  // A preview that wrote history would make the console's own confirmation step
  // look like an import that already happened.
  const stores = memStores();
  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
    batchId: "batch-dry",
    dryRun: true,
  });
  assert.equal(await stores.importBatches.get(ORG, "batch-dry"), undefined);
  assert.deepEqual(await stores.importBatches.listRows(ORG, "batch-dry"), []);
});

test("re-running the same batch does not inflate its membership", async () => {
  // Idempotent by (subscriber, list): a retried upload must not make a batch
  // look twice as large as the file it came from.
  const stores = memStores();
  const opts = {
    orgId: ORG,
    csv: csv(),
    plan: planFor(csv()),
    newListDefaults: DEFAULTS,
    batchId: "batch-d",
  };
  await importWithMapping(stores, clock, opts);
  const first = await stores.importBatches.listRows(ORG, "batch-d");
  await importWithMapping(stores, clock, opts);
  const second = await stores.importBatches.listRows(ORG, "batch-d");
  assert.equal(second.length, first.length);
});

test("batches list newest first, and only for their own org", async () => {
  const stores = memStores();
  for (const [i, id] of ["batch-old", "batch-new"].entries()) {
    await stores.importBatches.put({
      orgId: ORG,
      batchId: id,
      startedAt: `2026-0${i + 1}-01T00:00:00.000Z`,
      created: 0,
      updated: 0,
      subscriptionsCreated: 0,
      rowCount: 0,
    });
  }
  await stores.importBatches.put({
    orgId: "ledger",
    batchId: "batch-other",
    startedAt: "2026-12-01T00:00:00.000Z",
    created: 0,
    updated: 0,
    subscriptionsCreated: 0,
    rowCount: 0,
  });

  const listed = await stores.importBatches.list(ORG);
  assert.deepEqual(listed.map((b) => b.batchId), ["batch-new", "batch-old"]);
});

test("a mixed-basis file records no single basis rather than guessing one", async () => {
  const stores = memStores();
  const plan = suggestMapping(previewCsv(csv()), { consentBasis: "implicit" });
  const audiences = Object.entries(plan.columns).filter(([, m]) => m.kind === "audience");
  assert.ok(audiences.length >= 2, "the fixture maps more than one audience column");
  for (const [column, mapping] of audiences.slice(0, 1)) {
    if (mapping.kind !== "audience") continue;
    plan.columns[column] = { ...mapping, consentBasis: "explicit" };
  }

  await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: csv(),
    plan,
    newListDefaults: DEFAULTS,
    batchId: "batch-mixed",
  });
  const batch = await stores.importBatches.get(ORG, "batch-mixed");
  assert.equal(batch?.consentBasis, undefined, "two bases means no single answer");
});

test("columnsBlockingConfirmed names why a confirmed import must be refused", () => {
  // statusFor already fails closed, so an implicit basis can never PRODUCE a
  // confirmed row. But a 200 in response to "import this as confirmed" leaves an
  // operator believing the list is mailable, so the API refuses with the columns
  // that blocked it rather than downgrading in silence.
  const implicit = suggestMapping(previewCsv(csv()), { consentBasis: "implicit" });
  const blocked = columnsBlockingConfirmed(implicit);
  assert.ok(blocked.length > 0);

  const explicit = suggestMapping(previewCsv(csv()), { consentBasis: "explicit" });
  assert.deepEqual(columnsBlockingConfirmed(explicit), []);

  // One weak column is enough: the request covers the whole file.
  const [first] = blocked;
  const mixed = suggestMapping(previewCsv(csv()), { consentBasis: "explicit" });
  const m = mixed.columns[first as string];
  assert.ok(m && m.kind === "audience");
  mixed.columns[first as string] = { ...m, consentBasis: "implicit" };
  assert.deepEqual(columnsBlockingConfirmed(mixed), [first]);
});
