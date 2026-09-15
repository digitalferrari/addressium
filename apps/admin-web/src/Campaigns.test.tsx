/**
 * Campaigns list (#281, file #254).
 *
 * The screen joins two records that disagree, and every test here pins a place
 * where rendering the campaign record at face value would put a false statement
 * in front of an operator:
 *
 *   - `recordScheduledCampaign` writes `type: existing?.type ?? "one_off"` from
 *     BOTH branches of `POST /campaigns/schedule`, so the parent of a recurring
 *     series is stored as `one_off`. The lifecycle record's `kind` is the only
 *     truthful source.
 *   - That same parent never accumulates counters — its editions send under
 *     `<base>-<editionKey>` ids with no Campaign item — so a literal `0` reads
 *     as the frozen-counter bug (#221) rather than as "reported per edition".
 *   - It also has no `schedule.sendAt` (explicitly deleted), so its cron is the
 *     only timing it has.
 */
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { Campaigns, joinRows } from "./screens/Campaigns.js";
import { api, type CampaignRow, type SendScheduleState } from "./api.js";
import type { Grant } from "./rbac.js";

const ADMIN: Grant = { role: "developer_admin", orgs: "*" };
const ANALYST: Grant = { role: "analyst", orgs: ["acme"] };

/** A one-off that has finished sending. */
const SENT: CampaignRow = {
  campaignId: "ledger-2026-07-20",
  subject: "The Morning Ledger — Jul 20",
  status: "sent",
  type: "one_off",
  listId: "daily",
  sent: 96204,
  sendAt: "2026-07-20T12:00:00.000Z",
};

/**
 * The parent of a recurring series, exactly as the API returns it: `type` says
 * "one_off" (it cannot say otherwise), counters are zero, and there is no
 * `sendAt`.
 */
const SERIES_PARENT: CampaignRow = {
  campaignId: "weekly-brief",
  subject: "Market Signal — Weekly Brief",
  status: "scheduled",
  type: "one_off",
  listId: "weekly",
  sent: 0,
};

/** Authored through `POST /campaigns` and never scheduled — no lifecycle row. */
const DRAFT: CampaignRow = {
  campaignId: "v4-launch",
  subject: "Product Dispatch — v4 launch",
  status: "draft",
  type: "one_off",
  listId: "product",
  sent: 0,
};

const SENT_SCHEDULE: SendScheduleState = {
  orgId: "acme",
  scheduleId: "ledger-2026-07-20",
  kind: "one_off",
  status: "archived",
  sendAt: "2026-07-20T12:00:00.000Z",
  timezone: "America/Denver",
  createdAt: "2026-07-20T11:00:00.000Z",
  updatedAt: "2026-07-20T12:05:00.000Z",
};

const SERIES_SCHEDULE: SendScheduleState = {
  orgId: "acme",
  scheduleId: "weekly-brief",
  kind: "recurring",
  status: "paused",
  cron: "cron(0 6 ? * MON *)",
  timezone: "America/Denver",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(
  campaigns: CampaignRow[],
  schedules: SendScheduleState[],
  grant: Grant = ADMIN,
) {
  vi.spyOn(api, "campaigns").mockResolvedValue(campaigns as never);
  vi.spyOn(api, "schedules").mockResolvedValue(schedules as never);
  render(<Campaigns org="acme" grant={grant} />);
}

/** The row a campaign id sits in, so assertions are per-row and not per-screen. */
async function rowFor(id: string): Promise<HTMLElement> {
  const cell = await screen.findByText(`(${id})`);
  return cell.closest("tr") as HTMLElement;
}

test("a recurring parent is labelled a series even though its record says one_off", async () => {
  mount([SERIES_PARENT], [SERIES_SCHEDULE]);
  const row = await rowFor("weekly-brief");
  expect(within(row).getByText("series")).toBeTruthy();
});

test("a recurring parent shows no aggregate counter instead of a frozen zero", async () => {
  mount([SERIES_PARENT], [SERIES_SCHEDULE]);
  const row = await rowFor("weekly-brief");
  // The whole point: "0" next to a live series is indistinguishable from #221.
  expect(within(row).getByText("per edition")).toBeTruthy();
  expect(within(row).queryByText("0")).toBeNull();
});

test("a recurring parent falls back to its cron, having no send time", async () => {
  mount([SERIES_PARENT], [SERIES_SCHEDULE]);
  const row = await rowFor("weekly-brief");
  expect(within(row).getByText(/cron\(0 6 \? \* MON \*\)/)).toBeTruthy();
  expect(within(row).getByText(/America\/Denver/)).toBeTruthy();
});

test("a one-off shows its real send counter", async () => {
  mount([SENT], [SENT_SCHEDULE]);
  const row = await rowFor("ledger-2026-07-20");
  expect(within(row).getByText("96204")).toBeTruthy();
  expect(within(row).getByText("one-off")).toBeTruthy();
});

test("campaign status and lifecycle status are shown as the separate facts they are", async () => {
  // A SENT campaign on an ARCHIVED schedule: neither value implies the other,
  // and collapsing them into one column loses whichever is shown second.
  mount([SENT], [SENT_SCHEDULE]);
  const row = await rowFor("ledger-2026-07-20");
  expect(within(row).getByText("sent")).toBeTruthy();
  expect(within(row).getByText("ARCHIVED")).toBeTruthy();
});

test("a draft with no lifecycle record still lists, with no actions offered", async () => {
  mount([DRAFT], []);
  const row = await rowFor("v4-launch");
  expect(within(row).getByText("draft")).toBeTruthy();
  expect(within(row).getByText("not scheduled")).toBeTruthy();
  // "unscheduled", not "one-off": a campaign becomes one or the other only when
  // it is scheduled, and `campaign.type` defaults to "one_off" for everything.
  expect(within(row).getByText("unscheduled")).toBeTruthy();
  // No schedule exists, so Pause would post a scheduleId the route has no
  // record for. The control must be absent, not disabled-looking-clickable.
  expect(within(row).queryByRole("button", { name: "Pause" })).toBeNull();
});

test("an analyst sees the list read-only", async () => {
  mount([SERIES_PARENT], [SERIES_SCHEDULE], ANALYST);
  const row = await rowFor("weekly-brief");
  expect(within(row).getByText("read-only")).toBeTruthy();
  expect(within(row).queryByRole("button", { name: "Pause" })).toBeNull();
});

test("pausing a series reloads the lifecycle rows so the table is not stale", async () => {
  const lifecycle = vi
    .spyOn(api, "scheduleLifecycle")
    .mockResolvedValue({ ...SERIES_SCHEDULE, status: "paused" } as never);
  const active: SendScheduleState = { ...SERIES_SCHEDULE, status: "active" };
  vi.spyOn(api, "campaigns").mockResolvedValue([SERIES_PARENT] as never);
  const schedules = vi.spyOn(api, "schedules").mockResolvedValue([active] as never);
  render(<Campaigns org="acme" grant={ADMIN} />);

  const row = await rowFor("weekly-brief");
  within(row).getByRole("button", { name: "Pause" }).click();

  await waitFor(() => expect(lifecycle).toHaveBeenCalledWith("acme", "weekly-brief", "pause"));
  // The re-read is what keeps a second Pause from being offered on a row that
  // is already paused.
  await waitFor(() => expect(schedules.mock.calls.length).toBeGreaterThan(1));
});

test("a row does not flash 'not scheduled' while its lifecycle re-read is in flight", async () => {
  // `useAsync` clears `data` on every deps change, so the reload a Pause
  // triggers briefly leaves the join with no schedules at all. Rendering that
  // as "not scheduled" states something false about a record that exists — and
  // strips the buttons out from under the operator mid-click.
  vi.spyOn(api, "campaigns").mockResolvedValue([SERIES_PARENT] as never);
  const active: SendScheduleState = { ...SERIES_SCHEDULE, status: "active" };
  let release: (v: SendScheduleState[]) => void = () => {};
  vi.spyOn(api, "schedules")
    .mockResolvedValueOnce([active] as never)
    // Held open so the assertions below run during the reload, not after it.
    .mockImplementationOnce(() => new Promise((res) => { release = res as typeof release; }));
  vi.spyOn(api, "scheduleLifecycle").mockResolvedValue({ ...active, status: "paused" } as never);
  render(<Campaigns org="acme" grant={ADMIN} />);

  const row = await rowFor("weekly-brief");
  within(row).getByRole("button", { name: "Pause" }).click();

  await waitFor(() => expect(api.schedules).toHaveBeenCalledTimes(2));
  const reloading = await rowFor("weekly-brief");
  expect(within(reloading).queryByText("not scheduled")).toBeNull();
  // And the table is still the table: a reload must not drop a correct,
  // on-screen list behind a full-screen skeleton.
  expect(within(reloading).getByText("Market Signal — Weekly Brief")).toBeTruthy();
  expect(screen.queryByLabelText("Loading…")).toBeNull();

  release([{ ...active, status: "paused" }]);
  await waitFor(() => expect(within(rowFor2("weekly-brief")).queryByText("PAUSED")).toBeTruthy());
});

/** Synchronous row lookup, for assertions inside `waitFor`. */
function rowFor2(id: string): HTMLElement {
  return screen.getByText(`(${id})`).closest("tr") as HTMLElement;
}

test("a schedules failure costs the lifecycle column, not the campaign list", async () => {
  vi.spyOn(api, "campaigns").mockResolvedValue([SENT] as never);
  vi.spyOn(api, "schedules").mockRejectedValue(new Error("boom"));
  render(<Campaigns org="acme" grant={ADMIN} />);

  // The table still renders — blanking it over the secondary read would throw
  // away the half that loaded.
  const row = await rowFor("ledger-2026-07-20");
  expect(within(row).getByText("96204")).toBeTruthy();
  expect(await screen.findByText(/lifecycle state and actions are unavailable/)).toBeTruthy();
  // Unknown, NOT "not scheduled": the lifecycle record could not be read, and
  // claiming a scheduled campaign is unscheduled is the same false statement
  // the reload guard exists to prevent.
  expect(within(row).queryByText("not scheduled")).toBeNull();
  expect(within(row).getByText("unknown")).toBeTruthy();
});

test("a one-off that has already sent is not offered Start or Pause here either (#263)", async () => {
  // This table carries the same lifecycle controls as Schedules, so it needs
  // the same gate. `completed` is the status the sender writes; the archived
  // row below is the case `completeScheduleRange` leaves behind when an
  // operator archived the send before its last slice finished.
  mount([SENT], [{ ...SENT_SCHEDULE, status: "completed", completedRanges: [{}] }]);
  const row = await rowFor("ledger-2026-07-20");
  expect(within(row).getByText("COMPLETED")).toBeTruthy();
  expect(within(row).getByRole("button", { name: "Start" })).toBeDisabled();
  expect(within(row).getByRole("button", { name: "Pause" })).toBeDisabled();
});

test("a one-off archived mid-send is gated on its ranges, not its status", async () => {
  mount([SENT], [{ ...SENT_SCHEDULE, status: "archived", completedRanges: [{}] }]);
  const row = await rowFor("ledger-2026-07-20");
  expect(within(row).getByRole("button", { name: "Start" })).toBeDisabled();
});

test("an org with no campaigns gets an empty state, not an empty table", async () => {
  mount([], []);
  expect(await screen.findByText(/has no campaigns yet/)).toBeTruthy();
});

test("joinRows is campaign-driven, so a lifecycle row with no campaign is not a phantom", () => {
  // Drip sub-campaigns, re-engagement steps and series editions legitimately
  // hold schedule state under ids that have no Campaign item. They must not
  // appear here as rows with no subject.
  const orphan: SendScheduleState = { ...SERIES_SCHEDULE, scheduleId: "drip:welcome#0" };
  const rows = joinRows([SENT], [SENT_SCHEDULE, orphan]);
  expect(rows.map((r) => r.campaign.campaignId)).toEqual(["ledger-2026-07-20"]);
});

test("joinRows sorts by send time, leaving undated rows last", () => {
  const older: CampaignRow = { ...SENT, campaignId: "older", sendAt: "2026-07-01T12:00:00.000Z" };
  const rows = joinRows([SERIES_PARENT, older, SENT], []);
  expect(rows.map((r) => r.campaign.campaignId)).toEqual(["ledger-2026-07-20", "older", "weekly-brief"]);
});
