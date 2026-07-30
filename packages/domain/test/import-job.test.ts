/**
 * The import as a JOB rather than a request (#242).
 *
 * §4.7 promised an async job and the code took the whole file inline, putting API
 * Gateway's 10 MB payload limit, the Lambda invoke payload limit and the
 * 29-second integration timeout in front of the largest single write the system
 * ever takes. All three are reachable with an ordinary migration list.
 *
 * The failure shape is what these tests are really about. A run that dies leaves
 * a partially-imported list, and the operator's first question is "which rows
 * landed, and why did it stop" — so the batch record has to survive the crash
 * saying so. A job that fails silently, leaving `running` for ever, is
 * indistinguishable from one still working.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  importObjectKey,
  memStores,
  previewCsv,
  runImportJob,
  startImportJob,
  suggestMapping,
  type Clock,
  type ImportFileStore,
  type Stores,
} from "@addressium/domain";

const ORG = "summit";
const NOW = "2026-07-30T12:00:00.000Z";
const clock: Clock = { now: () => new Date(NOW) };

const jsonl = (...objs: Record<string, unknown>[]) => objs.map((o) => JSON.stringify(o)).join("\n");

const endpoint = (address: string, over: Record<string, unknown> = {}) => ({
  Id: address,
  ChannelType: "EMAIL",
  Address: address,
  EndpointStatus: "ACTIVE",
  OptOut: "NONE",
  Attributes: { SD_Ledger: ["true"] },
  ...over,
});

/** An in-memory blob store, so the job path is exercised without S3. */
const fileStoreOf = (objects: Record<string, Uint8Array>): ImportFileStore => ({
  read: async (key) => {
    const hit = objects[key];
    if (!hit) throw new Error(`no such object ${key}`);
    return hit;
  },
  presignUpload: async (key) => ({ url: `https://example.invalid/${key}`, key }),
});

async function seeded(): Promise<Stores> {
  const stores = memStores();
  await stores.lists.put({
    orgId: ORG,
    listId: "ledger",
    name: "SD_Ledger",
    optInPolicy: "double",
    fromAddress: "editor@summit.example",
    access: "free",
    visibility: "open",
    complianceFooter: "footer",
    physicalAddress: "1 Road",
  });
  return stores;
}

const planFor = (file: Uint8Array) =>
  suggestMapping(previewCsv(file), {
    knownLists: [{ listId: "ledger", name: "SD_Ledger" }],
    consentBasis: "implicit",
  });

test("the object key is derived from the batch id, in both directions", () => {
  // Derivable rather than stored-and-hoped: an operator holding a batchId can be
  // told exactly which object it read, and a retry of the same batch reads the
  // same object instead of some later upload nobody linked to it.
  assert.equal(importObjectKey(ORG, "imp_1"), "imports/summit/imp_1");
  assert.notEqual(importObjectKey(ORG, "imp_1"), importObjectKey("other", "imp_1"));
});

test("a batch is claimed `running` before anything is read", async () => {
  const stores = await seeded();
  await startImportJob(stores, clock, {
    orgId: ORG,
    batchId: "imp_1",
    sourceKey: importObjectKey(ORG, "imp_1"),
  });
  const batch = await stores.importBatches.get(ORG, "imp_1");
  // The API answers 202 with this id. Claiming after the read would leave a
  // window where the operator holds a batchId with nothing behind it.
  assert.equal(batch?.status, "running");
  assert.equal(batch?.sourceKey, "imports/summit/imp_1");
  assert.equal(batch?.finishedAt, undefined);
});

test("a gzipped export runs to completion and closes its batch with real counts", async () => {
  const stores = await seeded();
  const file = gzipSync(
    Buffer.from(jsonl(endpoint("a@example.com"), endpoint("b@example.com"), endpoint("c@example.com"))),
  );
  const key = importObjectKey(ORG, "imp_ok");
  await startImportJob(stores, clock, { orgId: ORG, batchId: "imp_ok", sourceKey: key });

  const report = await runImportJob(stores, clock, fileStoreOf({ [key]: new Uint8Array(file) }), {
    orgId: ORG,
    batchId: "imp_ok",
    sourceKey: key,
    plan: planFor(file),
  });

  assert.equal(report.created, 3);
  const batch = await stores.importBatches.get(ORG, "imp_ok");
  assert.equal(batch?.status, "completed");
  assert.ok(batch?.finishedAt, "a finished run must say when it finished");
  // Closing the batch must not clobber the counts importWithMapping wrote — it
  // reads-then-writes for exactly this reason.
  assert.equal(batch?.created, 3);
});

test("a job that throws still leaves a batch saying so", async () => {
  const stores = await seeded();
  const key = importObjectKey(ORG, "imp_gone");
  await startImportJob(stores, clock, { orgId: ORG, batchId: "imp_gone", sourceKey: key });

  await assert.rejects(
    () =>
      runImportJob(stores, clock, fileStoreOf({}), {
        orgId: ORG,
        batchId: "imp_gone",
        sourceKey: key,
        plan: { columns: {} },
      }),
    /no such object/,
  );

  const batch = await stores.importBatches.get(ORG, "imp_gone");
  // The whole point. Left at `running`, this is indistinguishable from a job
  // still working — and a half-imported list nobody can reason about.
  assert.equal(batch?.status, "failed");
  assert.match(batch?.error ?? "", /no such object/);
  assert.ok(batch?.finishedAt);
  // ...and it re-throws, so the Lambda's own error metric and alarm still fire.
});

test("an unreadable file fails the run rather than completing with nothing", async () => {
  const stores = await seeded();
  const key = importObjectKey(ORG, "imp_junk");
  await startImportJob(stores, clock, { orgId: ORG, batchId: "imp_junk", sourceKey: key });
  await runImportJob(
    stores,
    clock,
    fileStoreOf({ [key]: new Uint8Array(Buffer.from("{bad\n{alsobad")) }),
    { orgId: ORG, batchId: "imp_junk", sourceKey: key, plan: { columns: {} } },
  );
  const batch = await stores.importBatches.get(ORG, "imp_junk");
  assert.equal(batch?.status, "failed", "nothing imported and errors present is a failed run");
  assert.ok(batch?.error);
});

test("per-row errors do not fail a run that imported people", async () => {
  const stores = await seeded();
  const file = Buffer.from(
    [JSON.stringify(endpoint("good@example.com")), "{not json"].join("\n"),
  );
  const key = importObjectKey(ORG, "imp_partial");
  await startImportJob(stores, clock, { orgId: ORG, batchId: "imp_partial", sourceKey: key });
  const report = await runImportJob(stores, clock, fileStoreOf({ [key]: new Uint8Array(file) }), {
    orgId: ORG,
    batchId: "imp_partial",
    sourceKey: key,
    plan: planFor(new Uint8Array(file)),
  });

  assert.equal(report.created, 1);
  const batch = await stores.importBatches.get(ORG, "imp_partial");
  // A file where a few rows were malformed imported fine. Marking the whole run
  // failed would tell an operator to re-run an import that already worked —
  // and re-running is how you get duplicates.
  assert.equal(batch?.status, "completed");
  assert.ok(batch?.error, "but the bad line is still reported");
});
