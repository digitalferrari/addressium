/**
 * An import must never resurrect an unsubscribe (#293).
 *
 * Both import paths wrote the subscription unconditionally, so re-uploading a
 * list flipped an `unsubscribed` row back to `pending` or `confirmed` and the
 * person began receiving mail again after opting out. Reproduced before the
 * fix: unsubscribed -> re-import -> `confirmed`.
 *
 * This is the defect the product exists to prevent, and the moment it is most
 * likely to fire is a list re-upload during a migration — which is exactly what
 * the Pinpoint cutover is. `signup.ts` already refused the same transition; the
 * import paths simply did not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SystemClock, memStores, importCsvSubscribers } from "@addressium/domain";
import type { Stores } from "@addressium/domain";

const ORG = "acme";
const LIST = "ledger";

async function seed(): Promise<{ stores: Stores; clock: SystemClock }> {
  const stores = memStores();
  const clock = new SystemClock();
  await stores.lists.put({
    orgId: ORG, listId: LIST, name: "Ledger", optInPolicy: "double",
    fromAddress: "news@acme.example", access: "free", visibility: "open",
    complianceFooter: "footer", physicalAddress: "1 Main St",
  });
  return { stores, clock };
}

const csv = (email: string) => ({ orgId: ORG, listId: LIST, csv: `email\n${email}` });

test("a re-import does not reverse an unsubscribe", async () => {
  const { stores, clock } = await seed();
  await importCsvSubscribers(stores, clock, { ...csv("reader@x.example"), status: "confirmed" } as never);
  const sub = (await stores.subscribers.list(ORG))[0]!;

  // They unsubscribe.
  await stores.subscriptions.put({
    orgId: ORG, subscriberId: sub.sub, listId: LIST,
    status: "unsubscribed", updatedAt: clock.now().toISOString(),
  });

  // The same address appears in a later uploaded file.
  const report = await importCsvSubscribers(
    stores, clock, { ...csv("reader@x.example"), status: "confirmed" } as never,
  );

  const after = await stores.subscriptions.get(ORG, sub.sub, LIST);
  assert.equal(after?.status, "unsubscribed", "the import reversed an unsubscribe");
  // Counted, not silently dropped: an operator uploading a file deserves to see
  // that rows were skipped rather than believe they all landed.
  assert.ok(report.skipped >= 1, "the skipped row is reported");
});

test("a normal import still works for everyone else", async () => {
  // The guard must be narrow. If it also blocked new and pending rows the
  // import would be useless, and a test that only proves the block passes
  // trivially against a broken implementation.
  const { stores, clock } = await seed();
  await importCsvSubscribers(stores, clock, { ...csv("first@x.example"), status: "confirmed" } as never);
  const sub = (await stores.subscribers.list(ORG))[0]!;
  await stores.subscriptions.put({
    orgId: ORG, subscriberId: sub.sub, listId: LIST,
    status: "unsubscribed", updatedAt: clock.now().toISOString(),
  });

  await importCsvSubscribers(
    stores, clock,
    { orgId: ORG, listId: LIST, csv: "email\nfirst@x.example\nsecond@x.example", status: "confirmed" } as never,
  );

  const second = (await stores.subscribers.list(ORG)).find((s) => s.email === "second@x.example")!;
  assert.ok(second, "the new address was imported");
  assert.equal(
    (await stores.subscriptions.get(ORG, second.sub, LIST))?.status, "confirmed",
    "a fresh row still imports normally",
  );
  assert.equal(
    (await stores.subscriptions.get(ORG, sub.sub, LIST))?.status, "unsubscribed",
    "while the unsubscribed row beside it is left alone",
  );
});

test("re-importing a pending row still upgrades it", async () => {
  // `pending` -> `confirmed` is a legitimate transition an import may make.
  const { stores, clock } = await seed();
  await importCsvSubscribers(stores, clock, { ...csv("reader@x.example"), status: "pending" } as never);
  const sub = (await stores.subscribers.list(ORG))[0]!;

  await importCsvSubscribers(stores, clock, { ...csv("reader@x.example"), status: "confirmed" } as never);

  assert.equal((await stores.subscriptions.get(ORG, sub.sub, LIST))?.status, "confirmed");
});
