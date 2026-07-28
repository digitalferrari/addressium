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
import { importWithMapping, type NewListDefaults } from "../src/import-run.js";
import { memStores } from "../src/memory.js";
import type { Clock } from "../src/ports.js";

/** Fixed clock — a deterministic updatedAt keeps these assertions stable. */
const clock: Clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };

const ORG = "summit";
const FIXTURE = fileURLToPath(new URL("./fixtures/pinpoint-export.csv", import.meta.url));
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
