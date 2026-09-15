/**
 * Schedules — when a one-off actually fires (#248).
 *
 * Every one-off is placed at least five minutes out (`effectiveOneOffTime`,
 * §4.6) so it stays cancellable until it fires, and this screen is where the
 * Pause button lives. The cell read `{r.cron ? … : "—"}`, so a one-off — the
 * only kind of row with a deadline on it — showed "Cadence: —". An operator
 * could not tell whether the send they were looking at was due in four minutes
 * or next Tuesday, which is the one thing the pause window exists to let them
 * decide.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SendScheduleState } from "@addressium/core";
import { Schedules } from "./App.js";
import { api } from "./api.js";
import type { Grant } from "./rbac.js";

const ADMIN: Grant = { role: "developer_admin", orgs: "*" };

/** Frozen so the relative rendering is a fact, not a race with the clock. */
const NOW = new Date("2026-07-21T15:26:00.000Z");
/** Four minutes out: mid-pause-window, the case the screen exists to serve. */
const SOON = "2026-07-21T15:30:00.000Z";

const ONE_OFF: SendScheduleState = {
  orgId: "acme",
  scheduleId: "ledger-2026-07-21",
  kind: "one_off",
  status: "active",
  sendAt: SOON,
  timezone: "America/Denver",
  createdAt: "2026-07-21T15:25:00.000Z",
  updatedAt: "2026-07-21T15:25:00.000Z",
};

const SERIES: SendScheduleState = {
  orgId: "acme",
  scheduleId: "daily",
  kind: "recurring",
  status: "active",
  cron: "cron(0 6 * * ? *)",
  timezone: "America/Denver",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(rows: SendScheduleState[]) {
  vi.spyOn(api, "schedules").mockResolvedValue(rows as never);
  render(<Schedules org="acme" grant={ADMIN} />);
}

/**
 * What `Intl.RelativeTimeFormat` says for this offset, as a matcher.
 *
 * Derived rather than spelled "in 4 minutes": the screen formats against the
 * runtime's default locale, so a hard-coded English string would assert the CI
 * box's ICU default instead of the screen's behaviour.
 */
function relative(value: number, unit: Intl.RelativeTimeFormatUnit) {
  const text = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit);
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("a one-off shows when it fires, not a dash", async () => {
  mount([ONE_OFF]);
  const cell = await screen.findByText(relative(4, "minute"));
  // The absolute time is asserted only as a shape: `toLocaleString()` output is
  // locale- and zone-dependent, and pinning it would test the test runner's
  // environment rather than the screen.
  expect(cell.textContent).toMatch(/2026/);
  expect(screen.queryByText("—")).not.toBeInTheDocument();
});

test("the relative form is the actionable half — a past-due send reads as past", async () => {
  // A one-off that fired while paused is parked, not dropped (#179), so a row
  // whose time has gone by is a real state an operator lands on. "in 4 minutes"
  // and "4 minutes ago" demand opposite actions and must not look alike.
  mount([{ ...ONE_OFF, sendAt: "2026-07-21T15:22:00.000Z", status: "paused" }]);
  expect(await screen.findByText(relative(-4, "minute"))).toBeInTheDocument();
});

test("a recurring series still shows its cron and zone", async () => {
  mount([SERIES]);
  expect(await screen.findByText(/cron\(0 6 \* \* \? \*\)/)).toBeInTheDocument();
  expect(screen.getByText(/America\/Denver/)).toBeInTheDocument();
});

test("the column is headed When — half its rows are not a cadence", async () => {
  mount([ONE_OFF, SERIES]);
  await screen.findByText(relative(4, "minute"));
  expect(screen.getByRole("columnheader", { name: "When" })).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Cadence" })).not.toBeInTheDocument();
});

test("a record with neither a send time nor a cron still renders a dash", async () => {
  // Legacy rows written before the field existed. They degrade to the old
  // display rather than showing a blank cell.
  mount([{ ...ONE_OFF, sendAt: undefined, timezone: undefined }]);
  expect(await screen.findByText("—")).toBeInTheDocument();
});

test("a malformed send time degrades to a dash, not 'Invalid Date'", async () => {
  // `toLocaleString()` on an unparseable date prints "Invalid Date" — a string
  // an operator could read as a real state of the send rather than as a broken
  // record. The dash at least matches what a row with no time has always shown.
  mount([{ ...ONE_OFF, sendAt: "not-a-date" }]);
  expect(await screen.findByText("—")).toBeInTheDocument();
  expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
});
