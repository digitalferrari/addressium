/**
 * Analytics — the arithmetic, and the two states that actually break it.
 *
 * The screen's percentages are pure functions of counters the report already
 * returns, so they are tested directly rather than through the DOM. The two
 * cases worth guarding are the ones with no natural answer: a campaign that
 * sent nothing (every rate is 0/0) and a campaign with no recorded link map
 * (an empty table reads as "nobody clicked", which is a different claim).
 */
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Analytics, barWidth, funnelRows, linkCtr, pctOf, unresolved } from "./screens/Analytics.js";
import { api, type CampaignReport } from "./api.js";
import type { Grant } from "./rbac.js";

const GRANT: Grant = { role: "developer_admin", orgs: "*" };

/** Every counter distinct, so a cell reading the wrong field is visible. */
const COUNTERS: CampaignReport["counters"] = {
  sent: 1000,
  delivered: 940,
  opens: 310,
  clicks: 120,
  bounces: 41,
  complaints: 3,
  unsubscribes: 17,
  rejects: 6,
  renderingFailures: 8,
  deliveryDelays: 22,
};

const REPORT: CampaignReport = {
  campaignId: "daily-2026-07-21",
  counters: COUNTERS,
  rates: { openRate: 0.31, clickRate: 0.12, bounceRate: 0.041, complaintRate: 0.003 },
  clickMap: {
    sent: 1000,
    rows: [
      { linkId: "l1", label: "the chart everyone's sharing", urlTemplate: "https://example.com/chart", clicks: 90, unique: 84 },
      { linkId: "l2", label: "a deal to watch", urlTemplate: "https://example.com/deal", clicks: 30, unique: 28 },
    ],
  },
};

const EMPTY: CampaignReport = {
  campaignId: "never-sent",
  counters: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0 },
  rates: { openRate: 0, clickRate: 0, bounceRate: 0, complaintRate: 0 },
  clickMap: { sent: 0, rows: [] },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockApi(report: CampaignReport) {
  vi.spyOn(api, "campaigns").mockResolvedValue([
    { campaignId: report.campaignId, subject: "The Ledger" },
  ] as never);
  vi.spyOn(api, "report").mockResolvedValue(report as never);
  vi.spyOn(api, "analyticsTrends").mockResolvedValue({
    orgId: "acme", from: "2026-06-22", through: "2026-07-21", days: 30, points: [],
    summary: { subscriberCount: 1200, current: { emailsSent: 1000, openRate: 0.31, clickRate: 0.12 }, previous: { emailsSent: 900, openRate: 0.25, clickRate: 0.1 } },
  });
}

async function load(report: CampaignReport) {
  mockApi(report);
  const user = userEvent.setup();
  render(<Analytics org="acme" grant={GRANT} />);
  await user.selectOptions(await screen.findByRole("combobox"), report.campaignId);
  await user.click(screen.getByRole("button", { name: /Load/ }));
  return user;
}

// --- arithmetic -----------------------------------------------------------

test("a zero denominator is not zero percent", () => {
  // 0/0 has no answer, and "0.0%" would read as "nobody opened it" about a
  // campaign that never sent anything.
  expect(pctOf(0, 0)).toBe("—");
  expect(pctOf(5, 0)).toBe("—");
  expect(pctOf(310, 1000)).toBe("31.0%");
});

test("bar widths stay inside the card and never go NaN", () => {
  expect(barWidth(0, 0)).toBe(0);
  expect(barWidth(50, 100)).toBe(50);
  // Unique counts are not nested inside `sent` by construction, so a width
  // above 100 has to be clamped rather than trusted.
  expect(barWidth(150, 100)).toBe(100);
  expect(barWidth(-5, 100)).toBe(0);
});

test("every rate shares one denominator — sent — with the API's own rates", () => {
  // `deliverabilityRates` in packages/domain divides by `sent`. A per-link CTR
  // against `delivered` would disagree with the KPI row printed above it.
  const rows = funnelRows(COUNTERS);
  expect(rows.map((r) => r.label)).toEqual(["Sent", "Delivered", "Unique opens", "Unique clicks"]);
  expect(rows[1]!.share).toBe("94.0%"); // 940/1000, not 940/940
  expect(rows[2]!.share).toBe("31.0%"); // matches rates.openRate = 0.31
  expect(rows[3]!.share).toBe("12.0%"); // matches rates.clickRate = 0.12
  expect(linkCtr(REPORT.clickMap.rows[0]!, COUNTERS.sent)).toBe("9.0%"); // 90/1000
});

test("a campaign that sent nothing funnels to dashes, not to zeroes", () => {
  const rows = funnelRows(EMPTY.counters);
  expect(rows.every((r) => r.share === "—")).toBe(true);
  expect(rows.every((r) => r.width === 0)).toBe(true);
});

test("the unresolved residual is clamped and is not the delivery-delay count", () => {
  expect(unresolved(COUNTERS)).toBe(13); // 1000 - 940 - 41 - 6
  expect(unresolved(COUNTERS)).not.toBe(COUNTERS.deliveryDelays);
  // SES emits several events per message (a delay then a delivery counts in
  // both), so the residual goes negative on real data and must not render as
  // a negative bar or a negative count.
  expect(unresolved({ ...COUNTERS, delivered: 1000, bounces: 41 })).toBe(0);
});

// --- the two states that break the screen ---------------------------------

test("an absent link map says so rather than showing an empty table", async () => {
  await load(EMPTY);
  expect(await screen.findByText(/No link map recorded for this campaign/)).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: "Unique" })).toBeNull();
});

test("the links tab renders per-link clicks, unique and CTR", async () => {
  await load(REPORT);
  expect(await screen.findByText("the chart everyone's sharing")).toBeTruthy();
  expect(screen.getByText("84")).toBeTruthy(); // unique, not clicks
  expect(screen.getByText("9.0%")).toBeTruthy(); // CTR of sent
  expect(screen.getByRole("combobox", { name: "Campaign" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Clicks / sent" })).toBeTruthy();
  expect(screen.getByText(/includes repeat clicks and can exceed 100%/)).toBeTruthy();
});

test("per-link event percentages preserve repeat clicks above the sent count", () => {
  expect(linkCtr({ ...REPORT.clickMap.rows[0]!, clicks: 1200, unique: 84 }, 1000)).toBe("120.0%");
});

test("counters that point at our own bug are rendered, not hidden when small", async () => {
  await load(REPORT);
  // A rendering failure is an unresolved merge tag — our bug, not a mailbox's.
  expect(await screen.findByText("Rendering failures")).toBeTruthy();
  expect(screen.getByText("Rejects")).toBeTruthy();
  expect(screen.getByText("Delivery delays")).toBeTruthy();
});

test("the click-map tab explains when an older archive body is unavailable", async () => {
  const user = await load(REPORT);
  await user.click(await screen.findByRole("tab", { name: "Click map" }));
  expect(screen.getByText(/Archive preview unavailable for this campaign/)).toBeTruthy();
});

test("a grant that does not cover this org gets the refusal, not an empty screen", () => {
  // Every role in `rbac.ts` currently holds `reports:view`, so org SCOPE is the
  // real denial path here — an analyst entitled to read one org's reports must
  // not read another's. Asserted as scope rather than capability so the test
  // says what it actually proves.
  const analyst: Grant = { role: "analyst", orgs: ["other"] };
  render(<Analytics org="acme" grant={analyst} />);
  expect(screen.getByText(/can't view reports/)).toBeTruthy();
});

test("a null grant — an unrecognised role claim — is refused too", () => {
  render(<Analytics org="acme" grant={null} />);
  expect(screen.getByText(/can't view reports/)).toBeTruthy();
});
