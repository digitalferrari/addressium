/**
 * Dashboard — the landing page of a sending tool says something about sending (#261).
 *
 * It used to render a count of lists. What it renders now is bounded by what can
 * be derived from an endpoint that exists, and the failure mode these tests are
 * really guarding is the opposite of a blank panel: a plausible-looking number
 * with no source behind it. A fabricated complaint rate is the number somebody
 * decides NOT to investigate a deliverability problem over.
 *
 * So the assertions below are mostly about what the screen refuses to claim —
 * that an org with no thresholds reads as unprotected rather than as 0%, that a
 * campaign whose report will not load is distinguished from an org that has
 * never sent, and that `halted` does not render like `sent`.
 */
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Dashboard } from "./screens/Dashboard.js";
import { api, type AlertConfig, type CampaignReport, type CampaignRow, type SetupState } from "./api.js";

const SENT: CampaignRow = {
  campaignId: "ledger-2026-07-20",
  subject: "The Morning Ledger — Jul 20",
  status: "sent",
  type: "series_edition",
  listId: "ledger",
  sent: 96204,
  sendAt: "2026-07-20T12:00:00.000Z",
};

/** A LOWER id than the sent edition but a LATER send time — the route sorts by
 * `campaignId.localeCompare`, so id order and time order genuinely disagree. */
const DRAFT: CampaignRow = {
  campaignId: "aa-dispatch",
  subject: "Product Dispatch — v4 launch",
  status: "draft",
  type: "one_off",
  listId: "product",
  sent: 0,
};

const REPORT: CampaignReport = {
  campaignId: SENT.campaignId,
  counters: {
    sent: 100000, delivered: 99200, opens: 44100, clicks: 8300,
    bounces: 600, complaints: 30, unsubscribes: 120,
    rejects: 0, renderingFailures: 0, deliveryDelays: 0,
  },
  rates: { openRate: 0.441, clickRate: 0.083, bounceRate: 0.006, complaintRate: 0.0003 },
  clickMap: { sent: 100000, rows: [] },
};

const ALERTS: AlertConfig = {
  orgId: "acme",
  rules: [
    { metric: "complaint_rate", warnAt: 0.001, haltAt: 0.003, enabled: true },
    { metric: "bounce_rate", warnAt: 0.02, haltAt: 0.05, enabled: true },
  ],
  notifyTargets: [],
};

const SETUP_DONE: SetupState = { steps: [], requiredDone: 3, requiredTotal: 3, complete: true };
const SETUP_PENDING: SetupState = { steps: [], requiredDone: 1, requiredTotal: 3, complete: false };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(opts: {
  campaigns?: CampaignRow[];
  report?: CampaignReport | Error;
  alerts?: AlertConfig | null;
  setup?: SetupState;
} = {}) {
  vi.spyOn(api, "lists").mockResolvedValue([] as never);
  vi.spyOn(api, "setup").mockResolvedValue((opts.setup ?? SETUP_DONE) as never);
  vi.spyOn(api, "alertConfig").mockResolvedValue((opts.alerts === undefined ? ALERTS : opts.alerts) as never);
  vi.spyOn(api, "campaigns").mockResolvedValue((opts.campaigns ?? [SENT, DRAFT]) as never);
  const report = opts.report ?? REPORT;
  vi.spyOn(api, "report").mockImplementation(
    report instanceof Error ? () => Promise.reject(report) : () => Promise.resolve(report) as never,
  );
  vi.spyOn(api, "analyticsTrends").mockResolvedValue({
    orgId: "acme", from: "2026-06-22", through: "2026-07-21", days: 30, points: [],
    summary: { subscriberCount: 1200, current: { emailsSent: 1000, openRate: 0.31, clickRate: 0.12 }, previous: { emailsSent: 900, openRate: 0.25, clickRate: 0.1 } },
  });
  render(<Dashboard org="acme" onGoToSetup={() => {}} />);
}

test("the latest sent edition's own rates are shown, against the org's halt thresholds", async () => {
  mount();
  // Twice over: once as the deliverability panel's subject, once in the list.
  expect(await screen.findAllByText(/The Morning Ledger/)).toHaveLength(2);
  // 600/100000 bounces and 30/100000 complaints, as the report returned them.
  expect(screen.getByText("0.600%")).toBeInTheDocument();
  // 0.030%, NOT "0.0%". At one decimal place the whole actionable range for a
  // complaint rate — warn 0.1%, halt 0.3% — has four values in it, and a real
  // rate one tenth of the way to warn is indistinguishable from no complaints
  // at all. That rounding is the bug this row exists to avoid.
  expect(screen.getByText("0.030%")).toBeInTheDocument();
  // The thresholds are the ORG's, not an industry figure: 5% bounce, 0.3% complaint.
  expect(screen.getByText("5.0%")).toBeInTheDocument();
  expect(screen.getByText("0.300%")).toBeInTheDocument();
  expect(screen.getByText("Armed")).toBeInTheDocument();
});

test("a nonzero complaint rate never renders as 0%", async () => {
  // One complaint in a hundred thousand is a third of the way to the warn line.
  mount({ report: { ...REPORT, rates: { ...REPORT.rates, complaintRate: 0.00001 } } });
  await screen.findAllByText(/The Morning Ledger/);
  expect(screen.getByText("0.001%")).toBeInTheDocument();
  expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
});

test("the delivered row has no threshold to be missing, and does not claim one", async () => {
  // There is no delivered-rate metric in `AlertRule`. "none set" would read as
  // configuration an operator could supply and had not bothered to.
  mount();
  await screen.findByText("99.2%");
  expect(screen.queryByText("none set")).not.toBeInTheDocument();
});

test("delivered is computed from delivered/sent, not asserted", async () => {
  mount();
  // 99200/100000. The report returns no delivered rate; a screen that showed one
  // it had not computed would be showing a number with no source.
  expect(await screen.findByText("99.2%")).toBeInTheDocument();
});

test("an org with no thresholds reads as unprotected, never as 0%", async () => {
  // `alertConfig` returning null means nothing will halt a campaign that starts
  // generating complaints. Rendered as zeros it would look like a healthy org.
  mount({ alerts: null });
  expect(await screen.findByText(/no thresholds/)).toBeInTheDocument();
  expect(screen.queryByText("Armed")).not.toBeInTheDocument();
  // Exactly the two rows a rule COULD govern — bounces and complaints. Pinned
  // rather than `> 0`: the delivered row renders a dash, so a loose count would
  // survive a regression where a configured threshold silently reappeared.
  expect(screen.getAllByText("none set")).toHaveLength(2);
});

test("thresholds that exist but are all disabled are not 'Armed' either", async () => {
  mount({ alerts: { ...ALERTS, rules: ALERTS.rules.map((r) => ({ ...r, enabled: false })) } });
  expect(await screen.findByText(/every threshold is disabled/)).toBeInTheDocument();
});

test("a report that will not load still leaves the campaign list on screen", async () => {
  // The panel is one of four independent reads. Losing the report must not cost
  // the operator the half of the screen that did load.
  mount({ report: new Error("403: reports:view") });
  expect(await screen.findByText(/Could not load the report/)).toBeInTheDocument();
  expect(screen.getByText(/Product Dispatch/)).toBeInTheDocument();
});

test("an org that has never sent says so, rather than reporting on a draft", async () => {
  // Reporting a draft's zeroed counters as "0.0% bounces" would read as a clean
  // send record for an org that has never sent at all.
  mount({ campaigns: [DRAFT] });
  expect(await screen.findByText(/No campaign has finished sending yet/)).toBeInTheDocument();
  expect(api.report).not.toHaveBeenCalled();
});

test("an org with no campaigns gets an empty state, not a blank card", async () => {
  mount({ campaigns: [] });
  expect(await screen.findByText(/has not composed a campaign yet/)).toBeInTheDocument();
});

test("halted does not render like sent", async () => {
  // A halted send crossed a threshold and stopped with part of the list mailed.
  // Scanning past it because it looks the same as a clean send is the failure.
  mount({ campaigns: [{ ...SENT, campaignId: "halted-1", status: "halted" }, SENT] });
  const halted = await screen.findByText("halted");
  const sent = screen.getByText("sent");
  expect(halted).toBeInTheDocument();
  expect(halted.getAttribute("style")).not.toEqual(sent.getAttribute("style"));
});

test("recency is re-derived from sendAt — the route sorts by id, not by time", async () => {
  // DRAFT sorts FIRST by `campaignId.localeCompare` descending... it does not:
  // "ledger-…" > "aa-…", so the route puts SENT first by id. Give the draft a
  // later send time and the two orders disagree outright.
  const later: CampaignRow = { ...DRAFT, sendAt: "2026-07-25T12:00:00.000Z" };
  mount({ campaigns: [SENT, later] });
  await screen.findAllByText(/The Morning Ledger/);
  const rows = screen.getAllByRole("row").map((r) => r.textContent ?? "");
  const dispatch = rows.findIndex((t) => t.includes("Product Dispatch"));
  const ledger = rows.findIndex((t) => t.includes("Morning Ledger"));
  expect(dispatch).toBeLessThan(ledger);
});

test("a campaign with no send time renders a dash, not 'Invalid Date'", async () => {
  mount({ campaigns: [{ ...SENT, sendAt: "not-a-date" }] });
  expect(await screen.findAllByText("—")).not.toHaveLength(0);
  expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
});

test("the setup nag shows only while required steps are outstanding", async () => {
  mount({ setup: SETUP_PENDING });
  expect(await screen.findByText(/Finish setting up this organization/)).toBeInTheDocument();
  cleanup();
  vi.restoreAllMocks();
  mount({ setup: SETUP_DONE });
  await screen.findAllByText(/The Morning Ledger/);
  expect(screen.queryByText(/Finish setting up this organization/)).not.toBeInTheDocument();
});

test("the real 30-day trend is shown without invented KPI deltas", async () => {
  mount();
  await screen.findAllByText(/The Morning Ledger/);
  expect(screen.queryByText(/vs last mo/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Avg\. open rate/i)).not.toBeInTheDocument();
  expect(screen.getByText(/30-day trends/)).toBeInTheDocument();
});
