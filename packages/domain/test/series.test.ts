/**
 * Recurring campaign series (§4.6) — the CRUD the Ad tags screen is blocked on.
 *
 * The store has existed since the schema was written but nothing could reach it:
 * no route, no list method, no domain function. The tests below cover the three
 * things that break silently if this wiring is wrong:
 *
 *  1. `adSlotFills` ROUND-TRIPS. This is the whole reason the routes exist — the
 *     Ad tags control is "Applies to → series default (all editions)", which
 *     stores its HTML on the series. A save that dropped or mangled the fills
 *     would look fine on the save response and lose the operator's ad markup.
 *  2. `aggregate` SURVIVES an edit. Renaming a series must not reset the
 *     delivery counters every editions has contributed to.
 *  3. The refusals are `InvalidInputError`, so `fail()` answers 400 with a
 *     sentence the operator can read, not a generic 500 (#265).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Template } from "@addressium/core";
import {
  memStores,
  listCampaignSeries,
  getCampaignSeries,
  saveCampaignSeries,
  InvalidInputError,
} from "@addressium/domain";

const ORG = "summit";
const TEMPLATE = "ledger-weekly";

/** A series always names a template its editions reuse, so every case needs one. */
async function harness() {
  const stores = memStores();
  const template: Template = {
    orgId: ORG,
    templateId: TEMPLATE,
    name: "Ledger weekly",
    mode: "mjml",
    source: "<mjml></mjml>",
    version: 1,
    mergeTags: [],
    adSlots: ["ad_top"],
  };
  await stores.templates.put(template);
  return stores;
}

const base = {
  orgId: ORG,
  seriesId: "ledger",
  name: "The Ledger",
  cadence: "weekly" as const,
  templateId: TEMPLATE,
  adSlotFills: [],
};

test("a series is created, read back, and listed", async () => {
  const stores = await harness();
  const saved = await saveCampaignSeries(stores, base);
  assert.equal(saved.seriesId, "ledger");
  assert.equal(saved.cadence, "weekly");

  const one = await getCampaignSeries(stores, ORG, "ledger");
  assert.equal(one?.name, "The Ledger");

  const all = await listCampaignSeries(stores, ORG);
  assert.equal(all.length, 1);
});

test("a missing series reads as undefined, so the route can 404 rather than throw", async () => {
  const stores = await harness();
  assert.equal(await getCampaignSeries(stores, ORG, "nope"), undefined);
});

test("listing is scoped to the org and sorted by name", async () => {
  const stores = await harness();
  await saveCampaignSeries(stores, { ...base, seriesId: "zulu", name: "Zulu" });
  await saveCampaignSeries(stores, { ...base, seriesId: "alpha", name: "Alpha" });
  // Another org's series, reachable through the same store.
  await stores.series.put({
    orgId: "vail",
    seriesId: "other",
    name: "Other",
    cadence: "daily",
    templateId: TEMPLATE,
    adSlotFills: [],
    aggregate: {
      sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0,
      unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0,
    },
  });

  const rows = await listCampaignSeries(stores, ORG);
  assert.deepEqual(rows.map((r) => r.name), ["Alpha", "Zulu"]);
});

/**
 * The reason these routes exist. An ad fill saved on a series must come back
 * intact, and its binding must say it belongs to THIS series — that binding is
 * what the renderer reads to decide the fill applies to every edition.
 */
test("adSlotFills round-trip, and each is bound to this series", async () => {
  const stores = await harness();
  const saved = await saveCampaignSeries(stores, {
    ...base,
    adSlotFills: [{ slot: "ad_top", html: "<a href='https://example.com'>ad</a>", version: 3 }],
  });

  const fill = saved.adSlotFills[0];
  assert.equal(fill?.slot, "ad_top");
  assert.equal(fill?.html, "<a href='https://example.com'>ad</a>");
  assert.equal(fill?.version, 3);
  assert.deepEqual(fill?.binding, { kind: "series", seriesId: "ledger" });

  // And it survives the store, not just the return value.
  const read = await getCampaignSeries(stores, ORG, "ledger");
  assert.equal(read?.adSlotFills[0]?.html, "<a href='https://example.com'>ad</a>");
  assert.deepEqual(read?.adSlotFills[0]?.binding, { kind: "series", seriesId: "ledger" });
});

/**
 * A fill's binding is stamped from the series being saved, never trusted from
 * the payload. Otherwise a save against series A could write a fill claiming to
 * belong to series B — a cross-series write wearing the shape of a field.
 */
test("a caller cannot bind a fill to a different series", async () => {
  const stores = await harness();
  const saved = await saveCampaignSeries(stores, {
    ...base,
    seriesId: "ledger",
    adSlotFills: [
      // A payload that tried to smuggle another series' binding through.
      { slot: "ad_top", html: "<b>ad</b>", version: 1, binding: { kind: "series", seriesId: "victim" } },
    ] as never,
  });
  assert.deepEqual(saved.adSlotFills[0]?.binding, { kind: "series", seriesId: "ledger" });
});

/** Editing fills is a whole-array replace — otherwise removing one is inexpressible. */
test("saving with fewer fills removes the missing one", async () => {
  const stores = await harness();
  await saveCampaignSeries(stores, {
    ...base,
    adSlotFills: [
      { slot: "ad_top", html: "<b>top</b>", version: 1 },
      { slot: "ad_bottom", html: "<b>bottom</b>", version: 1 },
    ],
  });
  const trimmed = await saveCampaignSeries(stores, {
    ...base,
    adSlotFills: [{ slot: "ad_top", html: "<b>top</b>", version: 2 }],
  });
  assert.deepEqual(trimmed.adSlotFills.map((f) => f.slot), ["ad_top"]);
});

test("two fills for one slot are refused — the renderer could only pick one", async () => {
  const stores = await harness();
  await assert.rejects(
    () =>
      saveCampaignSeries(stores, {
        ...base,
        adSlotFills: [
          { slot: "ad_top", html: "<b>a</b>", version: 1 },
          { slot: "ad_top", html: "<b>b</b>", version: 1 },
        ],
      }),
    (e: unknown) => e instanceof InvalidInputError && /filled twice/.test((e as Error).message),
  );
});

/**
 * The counters are the rolled-up history of every edition. An edit that reset
 * them would silently destroy the numbers deliverability decisions are made on.
 */
test("editing a series preserves its aggregate counters", async () => {
  const stores = await harness();
  await saveCampaignSeries(stores, base);

  // Simulate editions having sent under this series.
  const stored = await stores.series.get(ORG, "ledger");
  assert.ok(stored);
  await stores.series.put({ ...stored, aggregate: { ...stored.aggregate, sent: 5000, bounces: 12 } });

  const renamed = await saveCampaignSeries(stores, { ...base, name: "The Ledger Weekly" });
  assert.equal(renamed.name, "The Ledger Weekly");
  assert.equal(renamed.aggregate.sent, 5000, "a rename must not reset the send count");
  assert.equal(renamed.aggregate.bounces, 12);
});

test("a new series starts at zero counters", async () => {
  const stores = await harness();
  const saved = await saveCampaignSeries(stores, base);
  assert.equal(saved.aggregate.sent, 0);
  assert.equal(saved.aggregate.rejects, 0, "spread from ZERO_COUNTERS, so #241's fields are present");
});

/**
 * `one_off` is in the shared `cadence` enum because campaigns use it. On a
 * series it is a contradiction, and the operator has to be told which value was
 * wrong — hence InvalidInputError (400 + sentence) not a bare Error (500).
 */
test("a one_off cadence is refused with a readable 400", async () => {
  const stores = await harness();
  await assert.rejects(
    () => saveCampaignSeries(stores, { ...base, cadence: "one_off" }),
    (e: unknown) => e instanceof InvalidInputError && /cannot be one_off/.test((e as Error).message),
  );
});

/**
 * A bad template id caught here is a 400 at save. Uncaught, it is a render
 * failure at send time, in an edition, at the worst possible moment.
 */
test("a template that does not exist is refused at save, not at send", async () => {
  const stores = await harness();
  await assert.rejects(
    () => saveCampaignSeries(stores, { ...base, templateId: "ghost" }),
    (e: unknown) => e instanceof InvalidInputError && /No template "ghost"/.test((e as Error).message),
  );
});

test("a template belonging to another org does not count as existing", async () => {
  const stores = await harness();
  await stores.templates.put({
    orgId: "vail",
    templateId: "vail-only",
    name: "Vail",
    mode: "mjml",
    source: "<mjml></mjml>",
    version: 1,
    mergeTags: [],
    adSlots: [],
  });
  await assert.rejects(
    () => saveCampaignSeries(stores, { ...base, templateId: "vail-only" }),
    (e: unknown) => e instanceof InvalidInputError,
  );
});
