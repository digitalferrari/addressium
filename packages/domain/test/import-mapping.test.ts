/**
 * Import field mapping (#216) — exercised against the synthetic Pinpoint export
 * in test/fixtures, so these tests fail if the real-world column shape changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyMapping,
  DEFAULT_TRISTATE,
  headerFingerprint,
  previewCsv,
  readTriState,
  suggestMapping,
  validateMapping,
  type MappingPlan,
} from "../src/import-mapping.js";
import { parseCsv } from "../src/importer.js";

// Resolved from the COMPILED location (dist/test/), because tsc does not
// copy non-TS assets — so this walks back to the source tree.
const FIXTURE = fileURLToPath(new URL("../../test/fixtures/pinpoint-export.csv", import.meta.url));
const csv = (): string => readFileSync(FIXTURE, "utf8");

const rowFor = (email: string): Record<string, string> => {
  const r = parseCsv(csv()).find((x) => x["Address"] === email);
  assert.ok(r, `fixture row not found: ${email}`);
  return r;
};

test("previewCsv reads the real Pinpoint column shape", () => {
  const p = previewCsv(csv());
  assert.equal(p.headers.length, 46);
  assert.equal(p.rowCount, 8);
  // The address column is `Address`, NOT a lowercase `email` header — this is
  // exactly why the original importer read a real export as zero rows (#209).
  assert.ok(p.headers.includes("Address"));
  assert.ok(!p.headers.includes("email"));
});

test("header fingerprint is order-insensitive so a saved mapping survives a reshuffled export", () => {
  assert.equal(headerFingerprint(["b", "A", "c"]), headerFingerprint(["c", "a", "B"]));
  assert.notEqual(headerFingerprint(["a", "b"]), headerFingerprint(["a", "b", "c"]));
});

test("readTriState keeps empty distinct from declined", () => {
  assert.equal(readTriState("true"), "subscribed");
  assert.equal(readTriState("false"), "declined");
  assert.equal(readTriState(""), "unknown");
  assert.equal(readTriState("   "), "unknown");
  assert.equal(readTriState("TRUE"), "subscribed");
  assert.equal(readTriState("Yes"), "subscribed");
  // Unrecognised text is NOT a decline — guessing here would invent consent history.
  assert.equal(readTriState("maybe"), "unknown");
});

test("suggestMapping finds the address, the safety columns, and the newsletters", () => {
  const p = previewCsv(csv());
  const plan = suggestMapping(p);

  assert.deepEqual(plan.columns["Address"], { kind: "email" });
  assert.equal(plan.columns["OptOut"]?.kind, "optOut");
  assert.equal(plan.columns["EndpointStatus"]?.kind, "endpointStatus");
  assert.equal(plan.columns["ChannelType"]?.kind, "channel");

  // Toggle-shaped columns under Attributes. become audiences...
  assert.equal(plan.columns["Attributes.SD_Skiing"]?.kind, "audience");
  assert.equal(plan.columns["Attributes.SD_E-EditionRegistrations"]?.kind, "audience");

  // ...but the non-list columns that merely live there do NOT. Inventing a
  // newsletter called "companyname" that someone could then send to is worse
  // than leaving it as an attribute.
  assert.equal(plan.columns["Attributes.companyname"]?.kind, "attribute");
  assert.equal(plan.columns["Attributes.audiences"]?.kind, "attribute");
  assert.equal(plan.columns["Attributes.contactOwner"]?.kind, "attribute");

  // Profile columns keep their leaf name, not the dotted path.
  assert.deepEqual(plan.columns["User.UserAttributes.firstName"], { kind: "attribute", key: "firstName" });

  // Endpoint noise is proposed for discard rather than stored as attributes.
  assert.equal(plan.columns["Id"]?.kind, "discard");
  assert.equal(plan.columns["Location.Latitude"]?.kind, "discard");
});

test("suggestMapping binds to existing lists and attributes instead of proposing duplicates", () => {
  const p = previewCsv(csv());
  const plan = suggestMapping(p, {
    knownLists: [{ listId: "lst_ski", name: "SD_Skiing" }],
    knownAttributes: ["FirstName"],
  });

  const ski = plan.columns["Attributes.SD_Skiing"];
  assert.equal(ski?.kind, "audience");
  assert.deepEqual(ski.kind === "audience" ? ski.list : null, { existingId: "lst_ski" });

  // Matched case-insensitively, but the org's existing spelling wins.
  assert.deepEqual(plan.columns["User.UserAttributes.firstName"], { kind: "attribute", key: "FirstName" });
});

test("every header gets a mapping, and the suggested plan validates", () => {
  const p = previewCsv(csv());
  const plan = suggestMapping(p);
  assert.equal(Object.keys(plan.columns).length, p.headers.length);
  assert.deepEqual(validateMapping(plan, p.headers), []);
});

test("validateMapping rejects a file with no email column", () => {
  const problems = validateMapping({ columns: { A: { kind: "discard" } } }, ["A"]);
  assert.ok(problems.some((x) => x.problem.includes("no column is mapped to the email address")));
});

test("validateMapping rejects two email columns and unmapped columns", () => {
  const plan: MappingPlan = { columns: { A: { kind: "email" }, B: { kind: "email" } } };
  const problems = validateMapping(plan, ["A", "B", "C"]);
  assert.ok(problems.some((x) => x.problem.includes("2 columns are mapped to email")));
  assert.ok(problems.some((x) => x.column === "C" && x.problem.includes("no mapping")));
});

test("validateMapping refuses two columns feeding one audience — the Sports / SD_Sports case", () => {
  const plan: MappingPlan = {
    columns: {
      Address: { kind: "email" },
      "Attributes.Sports": { kind: "audience", list: { existingId: "lst_sports" }, consentBasis: "implicit" },
      "Attributes.SD_Sports": { kind: "audience", list: { existingId: "lst_sports" }, consentBasis: "implicit" },
    },
  };
  const problems = validateMapping(plan, ["Address", "Attributes.Sports", "Attributes.SD_Sports"]);
  // The pair disagrees in the fixture, so silent last-write-wins would pick a
  // subscription state by column order. The operator has to resolve it.
  assert.ok(problems.some((x) => x.problem.includes("resolve the duplicate")));
});

test("validateMapping refuses two columns feeding one attribute key", () => {
  const plan: MappingPlan = {
    columns: {
      Address: { kind: "email" },
      A: { kind: "attribute", key: "name" },
      B: { kind: "attribute", key: "Name" },
    },
  };
  const problems = validateMapping({ ...plan }, ["Address", "A", "B"]);
  assert.ok(problems.some((x) => x.problem.includes("is the target of 2 columns")));
});

test("a mailable row maps to exactly its true columns", () => {
  const plan = suggestMapping(previewCsv(csv()));
  const r = applyMapping(plan, rowFor("alex.rivera@example.com"));

  assert.equal(r.email, "alex.rivera@example.com");
  assert.equal(r.mailable, true);
  assert.equal(r.audiences.length, 1);
  assert.deepEqual(r.audiences[0]?.list, { createNamed: "SD_E-EditionRegistrations" });
  assert.equal(r.declined.length, 8);
  assert.equal(r.attributes["firstName"], "Alex");
  assert.equal(r.attributes["birthDate"], "1985-03-18");
});

test("OptOut: ALL is never mailable even though it carries a true subscription", () => {
  const plan = suggestMapping(previewCsv(csv()));
  const r = applyMapping(plan, rowFor("jordan.lee@example.com"));

  assert.equal(r.audiences.length, 1, "the row does carry a true column");
  assert.equal(r.mailable, false, "but it must never be mailable");
  assert.ok(r.reasons.some((x) => x.includes("opted out")));
});

test("EndpointStatus: INACTIVE is never mailable even with two true subscriptions", () => {
  const plan = suggestMapping(previewCsv(csv()));
  const r = applyMapping(plan, rowFor("sam.patel@example.com"));

  assert.equal(r.audiences.length, 2);
  assert.equal(r.mailable, false);
  assert.ok(r.reasons.some((x) => x.includes("not active")));
});

test("a non-EMAIL channel is not an email subscriber", () => {
  const plan = suggestMapping(previewCsv(csv()));
  const r = applyMapping(plan, rowFor("+15550000000"));

  assert.equal(r.mailable, false);
  assert.ok(r.reasons.some((x) => x.includes("not an email endpoint")));
});

test("a blank address is reported, never silently skipped", () => {
  const plan = suggestMapping(previewCsv(csv()));
  const r = applyMapping(plan, rowFor(""));
  assert.ok(r.reasons.some((x) => x.includes("missing or invalid email address")));
});

test("an all-empty row yields ZERO subscriptions and ZERO declines", () => {
  const plan = suggestMapping(previewCsv(csv()));
  const r = applyMapping(plan, rowFor("morgan.diaz@example.com"));

  assert.equal(r.mailable, true);
  assert.equal(r.audiences.length, 0);
  // The whole point: a parser treating the file as booleans would record a
  // decline for every newsletter this person was never asked about.
  assert.equal(r.declined.length, 0, "empty means never asked, not declined");
});

test("embedded commas survive, and non-list columns stay attributes", () => {
  const plan = suggestMapping(previewCsv(csv()));
  const r = applyMapping(plan, rowFor("riley.chen@example.com"));

  assert.equal(r.attributes["audiences"], "Ski, Bike and Board");
  assert.equal(r.attributes["companyname"], "Chen, Riley & Co");
  assert.equal(r.attributes["address2"], "Suite 4, Bldg B");
  assert.equal(r.audiences.length, 0, "text columns must not become newsletters");
});

test("discarded columns are counted so a dropped column is never silent", () => {
  const plan = suggestMapping(previewCsv(csv()));
  const r = applyMapping(plan, rowFor("alex.rivera@example.com"));
  // Id, RequestId, EffectiveDate + the six Location.* columns.
  assert.equal(r.discardedColumns, 9);
});

test("a Mailchimp-shaped export auto-suggests correctly", () => {
  const p = previewCsv(
    ["Email Address,FNAME,LNAME", "dana.kim@example.com,Dana,Kim"].join("\n"),
  );
  const plan = suggestMapping(p);
  assert.deepEqual(plan.columns["Email Address"], { kind: "email" });
  assert.deepEqual(plan.columns["FNAME"], { kind: "attribute", key: "FNAME" });
  assert.deepEqual(validateMapping(plan, p.headers), []);

  const r = applyMapping(plan, { "Email Address": "Dana.Kim@Example.com ", FNAME: "Dana", LNAME: "Kim" });
  assert.equal(r.email, "dana.kim@example.com", "normalised on the way in");
});

test("a plain email header needs no interaction", () => {
  const p = previewCsv(["email,first_name", "pat@example.com,Pat"].join("\n"));
  const plan = suggestMapping(p);
  assert.deepEqual(plan.columns["email"], { kind: "email" });
  assert.deepEqual(validateMapping(plan, p.headers), []);
});

test("the email column is found by value shape when the header is unrecognisable", () => {
  const p = previewCsv(["contact_point,note", "lee@example.com,hello"].join("\n"));
  const plan = suggestMapping(p);
  assert.deepEqual(plan.columns["contact_point"], { kind: "email" });
});

test("a custom tri-state rule is honoured", () => {
  const plan: MappingPlan = {
    columns: {
      Address: { kind: "email" },
      Ski: {
        kind: "audience",
        list: { existingId: "lst_ski" },
        consentBasis: "explicit",
        rule: { subscribed: ["S"], declined: ["U"] },
      },
    },
  };
  assert.equal(applyMapping(plan, { Address: "a@b.co", Ski: "S" }).audiences.length, 1);
  assert.equal(applyMapping(plan, { Address: "a@b.co", Ski: "U" }).declined.length, 1);
  const none = applyMapping(plan, { Address: "a@b.co", Ski: "" });
  assert.equal(none.audiences.length + none.declined.length, 0);
  // The default vocabulary must not leak past a custom rule.
  assert.equal(applyMapping(plan, { Address: "a@b.co", Ski: "true" }).audiences.length, 0);
});

test("consent basis rides on each created subscription", () => {
  const p = previewCsv(csv());
  const plan = suggestMapping(p, { consentBasis: "explicit" });
  const r = applyMapping(plan, rowFor("alex.rivera@example.com"));
  assert.equal(r.audiences[0]?.consentBasis, "explicit");
});

test("DEFAULT_TRISTATE has no value in both lists", () => {
  const overlap = DEFAULT_TRISTATE.subscribed.filter((s) => DEFAULT_TRISTATE.declined.includes(s));
  assert.deepEqual(overlap, []);
});

test("a saved mapping is found again for a reshuffled re-export", async () => {
  const { memStores } = await import("../src/memory.js");
  const stores = memStores();
  const headers = ["Address", "Attributes.SD_Skiing", "User.UserAttributes.firstName"];
  const fingerprint = headerFingerprint(headers);

  await stores.importMappings.put({
    orgId: "summit",
    mappingId: "m1",
    name: "Monthly Pinpoint export",
    fingerprint,
    plan: { columns: { Address: { kind: "email" } } },
    updatedAt: "2026-07-28T00:00:00Z",
  });

  // Next month's file: same columns, different order. Remapping 73 columns by
  // hand every month is how one column ends up wrong.
  const reshuffled = ["User.UserAttributes.firstName", "Address", "Attributes.SD_Skiing"];
  const hits = await stores.importMappings.findByFingerprint("summit", headerFingerprint(reshuffled));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.name, "Monthly Pinpoint export");
});

test("a mapping saved for a different file shape is not offered", async () => {
  const { memStores } = await import("../src/memory.js");
  const stores = memStores();
  await stores.importMappings.put({
    orgId: "summit",
    mappingId: "m1",
    name: "Mailchimp",
    fingerprint: headerFingerprint(["Email Address", "FNAME"]),
    plan: { columns: {} },
    updatedAt: "2026-07-28T00:00:00Z",
  });

  const hits = await stores.importMappings.findByFingerprint(
    "summit",
    headerFingerprint(["Address", "OptOut"]),
  );
  assert.deepEqual(hits, [], "an unrelated file must not inherit someone else's mapping");
});

test("saved mappings are scoped to their org", async () => {
  const { memStores } = await import("../src/memory.js");
  const stores = memStores();
  const fp = headerFingerprint(["email"]);
  await stores.importMappings.put({
    orgId: "summit",
    mappingId: "m1",
    name: "theirs",
    fingerprint: fp,
    plan: { columns: {} },
    updatedAt: "t",
  });
  assert.deepEqual(await stores.importMappings.findByFingerprint("ledger", fp), []);
});
