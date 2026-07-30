/**
 * Reading a real Pinpoint export-job file (#239).
 *
 * The console/manual export gives CSV with dotted column paths, and that is what
 * `import-mapping.ts` was built against. A Pinpoint EXPORT JOB writes gzipped
 * JSON Lines of endpoint objects to S3 — which is what anyone with a real-sized
 * audience gets — and the importer read line 1 as a header, found no recognisable
 * column, errored every row and returned `created: 0`. A silent zero that reads
 * as success.
 *
 * The load-bearing test is the last one: a gzipped export through the SAME mapper
 * the CSV path uses, proving an `OptOut: ALL` endpoint lands non-mailable. That
 * is the compliance rule the whole flatten-to-dotted-paths design exists to
 * inherit rather than reimplement.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  decodeImportFile,
  detectImportFormat,
  flattenEndpoint,
  importWithMapping,
  memStores,
  parseEndpointJsonl,
  previewCsv,
  suggestMapping,
  type Clock,
} from "@addressium/domain";

const ORG = "summit";
const NOW = "2026-07-30T12:00:00.000Z";
const clock: Clock = { now: () => new Date(NOW) };

/** One endpoint object, shaped as a Pinpoint export job writes it. */
const endpoint = (over: Record<string, unknown> = {}) => ({
  Id: "ep-1",
  ChannelType: "EMAIL",
  Address: "reader@example.com",
  EndpointStatus: "ACTIVE",
  OptOut: "NONE",
  EffectiveDate: "2024-03-02T10:00:00.000Z",
  User: { UserId: "u-1", UserAttributes: { firstName: ["Ada"] } },
  Attributes: { SD_Ledger: ["true"], SD_Weekly: ["false"] },
  Location: { Country: "GB" },
  ...over,
});

const jsonl = (...objs: Record<string, unknown>[]) => objs.map((o) => JSON.stringify(o)).join("\n");

test("gzip is detected by magic bytes, not by a filename we were not given", () => {
  const text = jsonl(endpoint());
  assert.equal(decodeImportFile(gzipSync(Buffer.from(text))), text);
  // Plain bytes and plain strings pass through unchanged.
  assert.equal(decodeImportFile(new Uint8Array(Buffer.from(text))), text);
  assert.equal(decodeImportFile(text), text);
});

test("format detection distinguishes the two shapes, and refuses a third", () => {
  assert.equal(detectImportFormat(jsonl(endpoint())), "jsonl");
  assert.equal(detectImportFormat("Address,OptOut\na@b.co,NONE"), "csv");
  // A whole-file JSON array is a THIRD format. Quietly accepting one would mean
  // importing a file we only half understand.
  assert.equal(detectImportFormat('[{"Address":"a@b.co"}]'), "csv");
  assert.equal(detectImportFormat(""), "csv");
});

test("an endpoint flattens to exactly the dotted columns the CSV export uses", () => {
  // Byte-for-byte the same column names, which is what lets one mapper serve
  // both formats — and what stops the JSONL path drifting away from the CSV
  // path's compliance rules.
  assert.deepEqual(flattenEndpoint(endpoint()), {
    Id: "ep-1",
    ChannelType: "EMAIL",
    Address: "reader@example.com",
    EndpointStatus: "ACTIVE",
    OptOut: "NONE",
    EffectiveDate: "2024-03-02T10:00:00.000Z",
    "User.UserId": "u-1",
    "User.UserAttributes.firstName": "Ada",
    "Attributes.SD_Ledger": "true",
    "Attributes.SD_Weekly": "false",
    "Location.Country": "GB",
  });
});

test("a single-element array unwraps — the three-state audience logic depends on it", () => {
  // Pinpoint models every attribute as a list, so `["false"]` is how a DECLINED
  // audience flag arrives. Left as `["false"]` the mapper sees a value it does
  // not recognise and reads it as empty — and empty means NEVER ASKED. That
  // silently converts "declined" into "never asked", the one direction consent
  // must never move.
  assert.equal(flattenEndpoint({ A: { X: ["false"] } })["A.X"], "false");
  assert.equal(flattenEndpoint({ A: { X: ["a", "b"] } })["A.X"], "a,b");
  assert.equal(flattenEndpoint({ A: { X: null } })["A.X"], "");
  assert.equal(flattenEndpoint({ A: { X: [] } })["A.X"], "");
});

test("a malformed line is reported with its number, never skipped", () => {
  const { rows, errors } = parseEndpointJsonl(
    [JSON.stringify(endpoint()), "{not json", "", "[1,2]"].join("\n"),
  );
  assert.equal(rows.length, 1);
  // A dropped line in this file is an address that silently becomes mailable.
  assert.deepEqual(errors, ["line 2: not valid JSON", "line 4: expected a JSON object, got array"]);
});

test("preview reads the UNION of columns, because JSONL omits absent attributes", () => {
  // A CSV always emits every column as an empty cell; a JSONL export just leaves
  // the key out. Taking row 0's keys would hide real columns from the mapper and
  // from the operator staring at the wizard.
  const preview = previewCsv(
    gzipSync(
      Buffer.from(
        jsonl(
          { Address: "a@example.com", Attributes: { SD_Ledger: ["true"] } },
          { Address: "b@example.com", Attributes: { SD_Weekly: ["true"] } },
        ),
      ),
    ),
  );
  assert.equal(preview.rowCount, 2);
  assert.deepEqual(preview.headers.sort(), [
    "Address",
    "Attributes.SD_Ledger",
    "Attributes.SD_Weekly",
  ]);
});

test("a gzipped export imports end to end, and OptOut never becomes mailable", async () => {
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

  const file = gzipSync(
    Buffer.from(
      jsonl(
        endpoint({ Id: "ep-1", Address: "keen@example.com" }),
        endpoint({ Id: "ep-2", Address: "optedout@example.com", OptOut: "ALL" }),
        endpoint({ Id: "ep-3", Address: "inactive@example.com", EndpointStatus: "INACTIVE" }),
      ),
    ),
  );

  // The wizard previews with the same code that imports, so the plan built here
  // is the plan an operator would have confirmed.
  const preview = previewCsv(file);
  const plan = suggestMapping(preview, {
    knownLists: [{ listId: "ledger", name: "SD_Ledger" }],
    consentBasis: "implicit",
  });

  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: new Uint8Array(file),
    plan,
    batchId: "imp-jsonl",
    // The file's second audience column (SD_Weekly) has no list yet, and the
    // mapper refuses to invent a from-address or physical address for one — that
    // refusal is a CAN-SPAM guard, so the test supplies them rather than routing
    // around it.
    newListDefaults: {
      fromAddress: "editor@summit.example",
      complianceFooter: "footer",
      physicalAddress: "1 Road",
    },
  });

  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  assert.ok(report.created >= 3, `created ${report.created}`);

  // The rule the whole design exists to inherit rather than reimplement: a
  // row-level opt-out outranks a per-list `true`, and an INACTIVE endpoint is
  // not mailable either. Both are declared as `true` for SD_Ledger in this file.
  const keen = await stores.subscribers.findByEmail(ORG, "keen@example.com");
  const optedOut = await stores.subscribers.findByEmail(ORG, "optedout@example.com");
  const inactive = await stores.subscribers.findByEmail(ORG, "inactive@example.com");
  assert.ok(keen && optedOut && inactive, "every endpoint is imported — dropping one loses the opt-out");

  const mailable = async (sub: string) =>
    (await stores.subscriptions.get(ORG, sub, "ledger"))?.status === "confirmed";
  assert.equal(await mailable(optedOut!.sub), false, "OptOut: ALL must never be mailable");
  assert.equal(await mailable(inactive!.sub), false, "EndpointStatus: INACTIVE must never be mailable");
});

test("an unreadable file reports errors rather than a silent zero", async () => {
  const stores = memStores();
  const report = await importWithMapping(stores, clock, {
    orgId: ORG,
    csv: "{bad\n{alsobad",
    plan: { columns: {} },
    batchId: "imp-bad",
  });
  assert.equal(report.created, 0);
  // The #209 failure was `200 {created: 0}` reading as success. Whatever this
  // returns, it must carry a reason.
  assert.ok(report.errors.length > 0, "an unreadable file produced no error at all");
});
