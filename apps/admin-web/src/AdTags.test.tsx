import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdTags } from "./screens/AdTags.js";
import { api, type CampaignSeries, type Template } from "./api.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ZERO = { sent: 0, delivered: 0, bounced: 0, complained: 0, opens: 0, clicks: 0, unsubscribes: 0 };

const template = {
  orgId: "acme", templateId: "weekly", name: "Weekly", mode: "raw_html",
  source: "<p>hi</p>", version: 1, mergeTags: [], adSlots: ["ad_top", "ad_footer"],
} as unknown as Template;

const seriesRow = {
  orgId: "acme", seriesId: "weekly-news", name: "Weekly news", cadence: "weekly",
  templateId: "weekly",
  adSlotFills: [{ slot: "ad_top", html: "<a href='https://example.com'>ad</a>", binding: { kind: "series", seriesId: "weekly-news" }, version: 2 }],
  aggregate: ZERO,
} as unknown as CampaignSeries;

test("says plainly that series fills are active and explains both render paths", async () => {
  vi.spyOn(api, "series").mockResolvedValue([seriesRow]);
  vi.spyOn(api, "templates").mockResolvedValue([template]);
  render(<AdTags org="acme" />);
  const banner = await screen.findByRole("status");
  expect(banner).toHaveTextContent(/Series fills are active/);
  expect(banner).toHaveTextContent(/raw HTML or MJML/);
  expect(banner).toHaveTextContent(/\{\{ad_top\}\}/);
});

test("a failed series load is shown as a failure, not as an empty organization", async () => {
  vi.spyOn(api, "series").mockRejectedValue(new Error("network unavailable"));
  vi.spyOn(api, "templates").mockResolvedValue([template]);
  render(<AdTags org="acme" />);
  expect(await screen.findByText(/Could not load recurring series/)).toHaveTextContent("network unavailable");
  expect(screen.queryByText(/No recurring series yet/)).toBeNull();
});

test("a failed series report remains visible as a failure", async () => {
  vi.spyOn(api, "series").mockResolvedValue([seriesRow]);
  vi.spyOn(api, "templates").mockResolvedValue([template]);
  vi.spyOn(api, "seriesReport").mockRejectedValue(new Error("report unavailable"));
  const user = userEvent.setup();
  render(<AdTags org="acme" />);
  await user.click(await screen.findByRole("button", { name: "Report" }));
  expect(await screen.findByText(/Could not load series report/)).toHaveTextContent("report unavailable");
});

test("edits a series and round-trips its fills through saveSeries", async () => {
  vi.spyOn(api, "series").mockResolvedValue([seriesRow]);
  vi.spyOn(api, "templates").mockResolvedValue([template]);
  const save = vi.spyOn(api, "saveSeries").mockResolvedValue(seriesRow);
  const user = userEvent.setup();
  render(<AdTags org="acme" />);
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  // The stored fill loads into its slot's editor, and the undeclared slot is empty.
  expect(screen.getByLabelText("ad_top")).toHaveValue("<a href='https://example.com'>ad</a>");
  expect(screen.getByLabelText("ad_footer")).toHaveValue("");
  await user.type(screen.getByLabelText("ad_footer"), "<b>footer</b>");
  await user.click(screen.getByRole("button", { name: "Save ad tags" }));
  await screen.findByText("Ad tags saved.");
  const body = save.mock.calls[0]![0];
  expect(body.seriesId).toBe("weekly-news");
  // Version is preserved on the existing fill rather than reset to 1.
  expect(body.adSlotFills).toEqual(expect.arrayContaining([
    { slot: "ad_top", html: "<a href='https://example.com'>ad</a>", version: 2 },
    { slot: "ad_footer", html: "<b>footer</b>", version: 1 },
  ]));
});

/**
 * A fill for a slot the template no longer declares gets no editor row. Saving
 * it back would persist HTML the operator was never shown and cannot delete, so
 * it is named on screen and dropped by the save.
 */
test("names a fill whose slot the template no longer declares, and drops it on save", async () => {
  const stale = {
    ...seriesRow,
    adSlotFills: [
      ...seriesRow.adSlotFills,
      { slot: "ad_retired", html: "<i>old</i>", binding: { kind: "series", seriesId: "weekly-news" }, version: 1 },
    ],
  } as unknown as CampaignSeries;
  vi.spyOn(api, "series").mockResolvedValue([stale]);
  vi.spyOn(api, "templates").mockResolvedValue([template]);
  const save = vi.spyOn(api, "saveSeries").mockResolvedValue(seriesRow);
  const user = userEvent.setup();
  render(<AdTags org="acme" />);
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  expect(screen.queryByLabelText("ad_retired")).toBeNull();
  expect(screen.getByText(/no longer declares/)).toHaveTextContent("ad_retired");
  await user.click(screen.getByRole("button", { name: "Save ad tags" }));
  await screen.findByText("Ad tags saved.");
  expect(save.mock.calls[0]![0].adSlotFills.map((f) => f.slot)).toEqual(["ad_top"]);
});

/**
 * While `templates` is still in flight `template` is undefined, so `slots` falls
 * back to the fills' own slot names. Every stored fill must therefore look
 * declared — not orphaned — or a slow templates fetch would accuse the operator
 * of holding stale fills and then drop them on save.
 */
test("does not call stored fills orphaned while templates are still loading", async () => {
  vi.spyOn(api, "series").mockResolvedValue([seriesRow]);
  vi.spyOn(api, "templates").mockReturnValue(new Promise(() => {}) as Promise<Template[]>);
  const user = userEvent.setup();
  render(<AdTags org="acme" />);
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  expect(screen.queryByText(/no longer declares/)).toBeNull();
  // The fill still gets its editor row, sourced from the fill itself.
  expect(screen.getByLabelText("ad_top")).toHaveValue("<a href='https://example.com'>ad</a>");
});

test("points at Templates when the chosen template declares no slots", async () => {
  const bare = { ...template, templateId: "bare", name: "Bare", adSlots: [] } as unknown as Template;
  vi.spyOn(api, "series").mockResolvedValue([]);
  vi.spyOn(api, "templates").mockResolvedValue([bare]);
  const user = userEvent.setup();
  render(<AdTags org="acme" />);
  await user.click(await screen.findByRole("button", { name: /Add series/ }));
  expect(screen.getByText(/declares no ad slots/)).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/Structured ad blocks are replaced/);
});
