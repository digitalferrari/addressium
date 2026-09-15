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
import { Schedules } from "./screens/Schedules.js";
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

/**
 * A one-off that has already sent (#263).
 *
 * The domain records `completed` once the full recipient range goes out, and
 * `schedulesListHandler` returns the record verbatim — but `api.ts` mirrored
 * only the three operator-driven states, so the fired send arrived as a status
 * this screen had no case for and rendered through the "not active" fallbacks.
 */
const SENT: SendScheduleState = {
  ...ONE_OFF,
  scheduleId: "ledger-2026-07-20",
  status: "completed",
  sendAt: "2026-07-20T15:30:00.000Z",
  completedRanges: [{}],
};

test("a one-off that has already sent does not read ACTIVE", async () => {
  mount([SENT]);
  expect(await screen.findByText("COMPLETED")).toBeInTheDocument();
  expect(screen.queryByText("ACTIVE")).not.toBeInTheDocument();
});

test("a completed send is not offered a restart", async () => {
  // `transitionSchedule` rejects start and pause on a completed schedule, so a
  // live Start button offers an action the server will refuse — and implies the
  // send has not gone out yet, which is the whole complaint in #263.
  mount([SENT]);
  await screen.findByText("COMPLETED");
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
  // Archive is the one transition the domain still allows, and it is how a
  // fired one-off leaves a list an operator scans for what is still pending.
  expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();
});

test("a one-off archived mid-send is not offered a restart either", async () => {
  // `completeScheduleRange` writes `complete && status !== "archived"`, so an
  // operator's archive stands and the finished send keeps `archived` with its
  // ranges full. The domain refuses start/pause on THAT too — gating on the
  // status string alone would leave Start live and the server would answer
  // with the InvalidInputError this issue is about.
  mount([{ ...SENT, scheduleId: "filed-mid-send", status: "archived", completedRanges: [{}] }]);
  await screen.findByText("ARCHIVED");
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
});

test("an archived send that never fired can still be restarted", async () => {
  // The converse: archive is reversible for a send with no completed range, and
  // the guard above must not turn it into a second terminal state.
  mount([{ ...ONE_OFF, status: "archived", completedRanges: undefined }]);
  await screen.findByText("ARCHIVED");
  expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
});

test("a partial range is not treated as sent", async () => {
  // Only a range covering the whole key space completes a one-off. A slice that
  // has finished is mid-send, and pausing it is exactly the #179 deferral the
  // five-minute window exists for.
  mount([{ ...ONE_OFF, completedRanges: [{ until: "m" }] }]);
  await screen.findByText("ACTIVE");
  expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
});

test("completed is visually distinct from archived — they answer different questions", async () => {
  mount([SENT, { ...SENT, scheduleId: "filed", status: "archived" }]);
  const completed = await screen.findByText("COMPLETED");
  const archived = screen.getByText("ARCHIVED");
  expect(completed).toBeInTheDocument();
  expect(archived).toBeInTheDocument();
  // Asserted as "not the same colour" rather than against a hex literal: the
  // requirement is that an operator can tell "it sent" from "I filed it", not
  // that the palette never changes.
  expect(completed.style.background).not.toBe(archived.style.background);
});

test("an active one-off still gets its normal controls", async () => {
  // The guard above must not leak onto a send that has not fired: Pause is the
  // control the five-minute cancel window (§4.6) exists to make usable.
  mount([ONE_OFF]);
  await screen.findByText("ACTIVE");
  expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
});

test("a malformed send time degrades to a dash, not 'Invalid Date'", async () => {
  // `toLocaleString()` on an unparseable date prints "Invalid Date" — a string
  // an operator could read as a real state of the send rather than as a broken
  // record. The dash at least matches what a row with no time has always shown.
  mount([{ ...ONE_OFF, sendAt: "not-a-date" }]);
  expect(await screen.findByText("—")).toBeInTheDocument();
  expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
});
