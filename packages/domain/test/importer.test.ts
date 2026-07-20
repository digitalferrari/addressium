/**
 * CSV importer: parses headers/rows, maps attributes, dedupes within a batch,
 * skips suppressed addresses, and reports created/updated/skipped counts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { memStores, SystemClock, parseCsv, importCsvSubscribers } from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";

test("parseCsv maps headers to cells and handles quoted commas", () => {
  const rows = parseCsv('email,first,note\r\na@x.com,Ann,"hello, world"\nb@x.com,Bo,plain\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { email: "a@x.com", first: "Ann", note: "hello, world" });
  assert.equal(rows[1]?.note, "plain");
});

test("import creates subscribers + subscriptions, dedupes and reports counts", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  const csv = ["email,first", "A@X.com,Ann", "a@x.com,Dupe", "bob@x.com,Bob", "not-an-email,Nope"].join(
    "\n",
  );
  const report = await importCsvSubscribers(stores, clock, { orgId: ORG, listId: LIST, csv });

  assert.equal(report.created, 2); // a@x.com + bob@x.com
  assert.equal(report.skipped, 1); // the second a@x.com (case-insensitive dupe)
  assert.equal(report.errors.length, 1); // not-an-email

  const ann = await stores.subscribers.findByEmail(ORG, "a@x.com");
  assert.ok(ann);
  assert.equal(ann?.attributes?.["first"], "Ann"); // first-seen row wins
  const sub = await stores.subscriptions.get(ORG, ann!.sub, LIST);
  assert.equal(sub?.status, "confirmed");
});

test("import updates attributes for an existing subscriber and skips suppressed", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  await importCsvSubscribers(stores, clock, {
    orgId: ORG,
    listId: LIST,
    csv: "email,first\nann@x.com,Ann",
  });
  await stores.suppression.add({
    orgId: ORG,
    email: "blocked@x.com",
    source: "unsubscribe",
    scope: "org",
    addedAt: clock.now().toISOString(),
  });

  const report = await importCsvSubscribers(stores, clock, {
    orgId: ORG,
    listId: LIST,
    csv: "email,first,city\nann@x.com,Ann,Denver\nblocked@x.com,Nope,Nowhere",
  });
  assert.equal(report.updated, 1);
  assert.equal(report.skipped, 1); // suppressed address
  const ann = await stores.subscribers.findByEmail(ORG, "ann@x.com");
  assert.equal(ann?.attributes?.["city"], "Denver");
});

test("dryRun reports counts without writing", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  const report = await importCsvSubscribers(stores, clock, {
    orgId: ORG,
    listId: LIST,
    csv: "email\nnew@x.com",
    dryRun: true,
  });
  assert.equal(report.created, 1);
  assert.equal(await stores.subscribers.findByEmail(ORG, "new@x.com"), undefined);
});
