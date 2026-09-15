/**
 * Recurring campaign series (§4.6) — the parent record behind every
 * `series_edition` campaign, and what an ad slot binds to when one fill should
 * appear in EVERY edition rather than in one send.
 *
 * The store has existed since the schema was written and was reachable only
 * from inside the send path; nothing could create or read a series over HTTP.
 * That is the gap this module closes, because "Applies to → series default (all
 * editions)" on the Ad tags screen is a control that binds to a series, and a
 * dropdown cannot offer what no route can list.
 *
 * Two invariants are enforced here rather than in zod, because both need the
 * operator to read WHICH thing was wrong and why — a ZodError answers with one
 * generic sentence (#265):
 *
 *  1. A series' cadence may not be `one_off`. The enum is shared with campaigns,
 *     where `one_off` is the normal case; on a series it is a contradiction —
 *     a series is precisely the thing that recurs, and one with no recurrence
 *     would be listed as a schedulable parent that can never produce an edition.
 *  2. The template must exist. A series carries the template its editions reuse,
 *     so a bad id is not discovered when the series is saved, it is discovered
 *     when the first edition tries to render at send time — the worst possible
 *     moment and the hardest to trace back here.
 *
 * `aggregate` is NEVER taken from the caller. It is the rolled-up delivery
 * history of every edition this series has sent; accepting it on the wire would
 * let a console edit — renaming a series — silently reset or forge the numbers
 * an operator makes deliverability decisions on.
 */
import type { AdSlotFill, CampaignSeries, schemas } from "@addressium/core";
import { ZERO_COUNTERS } from "./admin.js";
import { InvalidInputError, type Stores } from "./ports.js";

/** Every series in the org, by name, for the console's pickers and list. */
export async function listCampaignSeries(stores: Stores, orgId: string): Promise<CampaignSeries[]> {
  const rows = await stores.series.list(orgId);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One series, or `undefined` when there is no such id.
 *
 * Returning `undefined` rather than throwing keeps the 404 decision at the
 * route, matching how `templatesHandler` reads a single template.
 */
export async function getCampaignSeries(
  stores: Stores,
  orgId: string,
  seriesId: string,
): Promise<CampaignSeries | undefined> {
  return stores.series.get(orgId, seriesId);
}

/**
 * Create or update a series.
 *
 * Update is a full replace of the caller-supplied fields, with two things
 * carried forward from the stored row because they are not the caller's to set:
 *
 *  - `aggregate`, for the reason above — an edit must not touch the counters.
 *  - nothing else; name, cadence, templateId and adSlotFills are all replaced,
 *    which is what makes removing an ad fill expressible at all (a merge could
 *    only ever add).
 *
 * Each fill's `binding` is stamped from THIS series rather than trusted from the
 * payload, so a fill cannot claim to belong to another series.
 */
export async function saveCampaignSeries(
  stores: Stores,
  input: schemas.SaveCampaignSeriesInput,
): Promise<CampaignSeries> {
  if (input.cadence === "one_off") {
    throw new InvalidInputError(
      "A series recurs by definition, so its cadence cannot be one_off. Choose daily, weekly, biweekly or monthly — or send a one-off campaign instead.",
    );
  }
  const template = await stores.templates.get(input.orgId, input.templateId);
  if (!template) {
    throw new InvalidInputError(
      `No template "${input.templateId}" exists in this organization. A series holds the template its editions reuse, so it must name one that exists.`,
    );
  }
  // Two fills for one slot is not an edit, it is an ambiguity: the renderer
  // takes one and the operator cannot tell which. Refused here so it is refused
  // at the moment it is authored rather than discovered in a rendered edition.
  const slots = input.adSlotFills.map((f) => f.slot);
  const duplicate = slots.find((s, i) => slots.indexOf(s) !== i);
  if (duplicate !== undefined) {
    throw new InvalidInputError(
      `Slot "${duplicate}" is filled twice. Each ad slot takes one fill per series.`,
    );
  }

  const existing = await stores.series.get(input.orgId, input.seriesId);
  const adSlotFills: AdSlotFill[] = input.adSlotFills.map((f) => ({
    slot: f.slot,
    html: f.html,
    binding: { kind: "series", seriesId: input.seriesId },
    version: f.version,
  }));
  const series: CampaignSeries = {
    orgId: input.orgId,
    seriesId: input.seriesId,
    name: input.name,
    cadence: input.cadence,
    templateId: input.templateId,
    adSlotFills,
    // Counters survive every edit. A new series starts at the shared zero
    // (spread, not a literal — #241 added three fields at once).
    aggregate: existing?.aggregate ?? { ...ZERO_COUNTERS },
  };
  await stores.series.put(series);
  return series;
}
