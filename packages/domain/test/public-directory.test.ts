/**
 * The public newsletter directory (#124).
 *
 * The subscriber site's browse page — the front door of the whole public site —
 * was calling the ADMIN `GET /orgs/{org}/lists`, which sits behind the console's
 * JWT authorizer. It could only ever have returned 401.
 *
 * Making that handler public would have been wrong twice over, and both reasons
 * are what these cover: it returns CLOSED lists, and it returns the operator's
 * compliance fields.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { List } from "@addressium/core";
import { memStores, publicListDirectory, type Stores } from "@addressium/domain";

const ORG = "summit";

const list = (over: Partial<List> & { listId: string; name: string }): List => ({
  orgId: ORG,
  optInPolicy: "double",
  fromAddress: "ops@summitdaily.test",
  access: "free",
  visibility: "open",
  complianceFooter: "You subscribed at summitdaily.test",
  physicalAddress: "1 Main St, Frisco CO",
  ...over,
});

async function seeded(): Promise<Stores> {
  const stores = memStores();
  await stores.lists.put(list({ listId: "ledger", name: "The Ledger", description: "Daily business" }));
  await stores.lists.put(list({ listId: "arts", name: "Arts Weekly" }));
  await stores.lists.put(list({ listId: "retired", name: "Retired Bulletin", visibility: "closed" }));
  return stores;
}

test("a closed list never appears in the directory", async () => {
  // `closed` means "not accepting signups". Advertising it invites people to a
  // door that will not open — and it is the operator's business that the list
  // exists at all.
  const stores = await seeded();
  const ids = (await publicListDirectory(stores, ORG)).map((l) => l.listId);
  assert.deepEqual(ids.sort(), ["arts", "ledger"]);
  assert.ok(!ids.includes("retired"));
});

test("the directory leaks none of the operator's compliance fields", async () => {
  // fromAddress, complianceFooter and physicalAddress are operational. The
  // admin lists handler returns all three; a page anyone can load must not.
  const stores = await seeded();
  const rendered = JSON.stringify(await publicListDirectory(stores, ORG));
  for (const secret of ["ops@summitdaily.test", "1 Main St, Frisco CO", "You subscribed at"]) {
    assert.ok(!rendered.includes(secret), `directory leaked: ${secret}`);
  }
  assert.doesNotMatch(rendered, /optInPolicy|fromAddress|physicalAddress|complianceFooter/);
});

test("presentation toggles are honoured, so a hidden count stays hidden", async () => {
  // Same rule publicListView already enforced for one list — the directory must
  // not become a way around it.
  const stores = memStores();
  await stores.lists.put(
    list({
      listId: "quiet",
      name: "Quiet",
      description: "should not show",
      presentation: {
        showFrequency: false,
        showSendTime: false,
        showDescription: false,
        showReaderCount: false,
        showFreePaidCount: false,
      },
    }),
  );
  const [only] = await publicListDirectory(stores, ORG);
  assert.equal(only?.description, undefined, "description hidden by its toggle");
  assert.equal(only?.readerCount, undefined);
  assert.equal(only?.freePaidCount, undefined);
});

test("the order is stable and by name", async () => {
  // A directory whose order shifts between loads reads as broken.
  const stores = await seeded();
  const names = (await publicListDirectory(stores, ORG)).map((l) => l.name);
  assert.deepEqual(names, ["Arts Weekly", "The Ledger"]);
  assert.deepEqual((await publicListDirectory(stores, ORG)).map((l) => l.name), names);
});

test("an org with no open lists returns an empty directory, not an error", async () => {
  const stores = memStores();
  await stores.lists.put(list({ listId: "x", name: "X", visibility: "closed" }));
  assert.deepEqual(await publicListDirectory(stores, ORG), []);
  assert.deepEqual(await publicListDirectory(stores, "nobody"), []);
});

test("one org's directory never shows another's lists", async () => {
  const stores = await seeded();
  await stores.lists.put({ ...list({ listId: "other", name: "Other" }), orgId: "ledger-co" });
  const ids = (await publicListDirectory(stores, ORG)).map((l) => l.listId);
  assert.ok(!ids.includes("other"));
});
