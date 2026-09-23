/**
 * Per-edition series reporting (#306).
 *
 * The data already existed: every firing writes its own `Campaign` row with its
 * own counters, and `seriesReportHandler` has always returned `editions[]`
 * alongside the aggregate. The only consumer was the Ad tags screen, which
 * showed the aggregate and "N editions included" — so a bad send was invisible,
 * averaged into a total nobody could break apart.
 *
 * The subtle part is the rate arithmetic. Averaging per-edition rates weights a
 * 200-recipient test send the same as a 20,000-recipient edition, which
 * misreports the month in the direction nobody checks.
 */
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Report } from "./screens/Report.js";
import { api } from "./api.js";
import type { Grant } from "./rbac.js";

const ADMIN: Grant = { role: "developer_admin", orgs: "*" };

const counters = (o: Partial<Record<string, number>> = {}) => ({
  sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0,
  unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0,
  ...o,
});

/** Two editions of wildly different size — the case averaging gets wrong. */
const REPORT = {
  orgId: "acme",
  seriesId: "daily",
  editions: [
    // 20,000 delivered, 10% open rate
    { campaignId: "daily-2026-09-20", subject: "Friday", status: "scheduled",
      counters: counters({ sent: 20000, delivered: 20000, opens: 2000, clicks: 200, bounces: 10, unsubscribes: 5 }) },
    // 200 delivered, 50% open rate — a small test send
    { campaignId: "daily-2026-09-21", subject: "Saturday", status: "scheduled",
      counters: counters({ sent: 200, delivered: 200, opens: 100, clicks: 20, bounces: 1, unsubscribes: 0 }) },
  ],
  aggregate: counters({ sent: 20200, delivered: 20200, opens: 2100, clicks: 220, bounces: 11, unsubscribes: 5 }),
  rates: { openRate: 0.104, clickRate: 0.011, bounceRate: 0.0005, complaintRate: 0 },
};

afterEach(() => cleanup());

function mount() {
  vi.spyOn(api, "campaigns").mockResolvedValue([] as never);
  vi.spyOn(api, "series").mockResolvedValue([
    { orgId: "acme", seriesId: "daily", name: "The Daily", cadence: "daily", templateId: "t1", adSlotFills: [], aggregate: counters() },
  ] as never);
  vi.spyOn(api, "seriesReport").mockResolvedValue(REPORT as never);
  render(<Report org="acme" grant={ADMIN} />);
}

async function loadEditions() {
  mount();
  fireEvent.change(await screen.findByLabelText("Series"), { target: { value: "daily" } });
  fireEvent.click(screen.getByRole("button", { name: /load editions/i }));
  await waitFor(() => expect(screen.getByText("Friday")).toBeTruthy());
}

test("every edition is listed separately, not just the total", async () => {
  await loadEditions();
  expect(screen.getByText("Friday")).toBeTruthy();
  expect(screen.getByText("Saturday")).toBeTruthy();
});

test("rates come from summed counters, not averaged per-edition rates", async () => {
  // Averaging would give (10% + 50%) / 2 = 30%. The truth is
  // 2100 / 20200 = 10.4%. A test send must not move the monthly number.
  await loadEditions();
  expect(screen.getByText(/opens \(10\.4%\)/)).toBeTruthy();
  expect(screen.queryByText(/opens \(30\.0%\)/)).toBeNull();
});

test("the date window filters editions and re-totals them", async () => {
  await loadEditions();
  // Narrow to the Saturday edition only.
  fireEvent.change(screen.getByLabelText(/from/i), { target: { value: "2026-09-21" } });
  await waitFor(() => expect(screen.queryByText("Friday")).toBeNull());
  expect(screen.getByText("Saturday")).toBeTruthy();
  // 100 / 200 = 50% for that edition alone.
  expect(screen.getByText(/opens \(50\.0%\)/)).toBeTruthy();
});

test("a window with no editions says so rather than showing zeroes", async () => {
  // An empty totals row reads as "the series sent nothing", which is a
  // different claim from "you picked a window with no sends in it".
  await loadEditions();
  fireEvent.change(screen.getByLabelText(/from/i), { target: { value: "2027-01-01" } });
  await waitFor(() => expect(screen.getByText(/no editions in this window/i)).toBeTruthy());
});

test("the edition column shows the firing key, not the full campaign id", async () => {
  // `daily-2026-09-20` in a column headed "Edition" under a series called
  // "daily" is mostly redundant prefix.
  await loadEditions();
  expect(screen.getByText("2026-09-20")).toBeTruthy();
});
