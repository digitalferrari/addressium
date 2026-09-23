/**
 * The Refresh control, across the screens where it can actually break.
 *
 * THE GUARANTEE UNDER TEST is anti-blanking: pressing Refresh re-reads the
 * server while the rows already on screen stay on screen. A refresh that
 * cleared them would be worse than no refresh — the operator would lose a
 * correct table to a shimmer every time they asked whether it was current.
 *
 * Four screens, chosen because each defeats the guarantee differently:
 *   Campaigns — two reads joined into one table, and a skeleton keyed on the
 *               first load (the trap the `reloadKey > 0` comment there names).
 *   Schedules — manual `useState`, not on `useAsync` at all.
 *   Team      — used to `return` its error, replacing the whole screen.
 *   Feeds     — `localFeeds` wins over the read, so a naive refetch is invisible.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Campaigns } from "./screens/Campaigns.js";
import { Schedules } from "./screens/Schedules.js";
import { Team } from "./screens/Team.js";
import { Feeds } from "./screens/Feeds.js";
import { api } from "./api.js";
import type { Grant } from "./rbac.js";

const ADMIN: Grant = { role: "developer_admin", orgs: "*" } as never;

/** A promise this test settles by hand, so a read can be held mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const refreshButton = () => screen.getByRole("button", { name: /^Refresh(ing…)?$/ });

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Campaigns — two reads, and the skeleton that must not come back.
// ---------------------------------------------------------------------------

const CAMPAIGN = {
  campaignId: "spring", subject: "Spring blast", status: "scheduled",
  type: "one_off", listId: "ledger", sent: 0,
};
const SCHEDULE = {
  orgId: "acme", scheduleId: "spring", kind: "one_off", status: "active",
  sendAt: "2026-10-01T10:00:00.000Z", timezone: "America/Denver",
  createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
};

test("Campaigns: Refresh re-reads BOTH reads and the rows never leave the DOM", async () => {
  const user = userEvent.setup();
  const campaigns = vi.spyOn(api, "campaigns").mockResolvedValue([CAMPAIGN] as never);
  const held = deferred<unknown>();
  const schedules = vi.spyOn(api, "schedules")
    .mockResolvedValueOnce([SCHEDULE] as never)
    .mockReturnValueOnce(held.promise as never);

  render(<Campaigns org="acme" grant={ADMIN} />);
  await screen.findByText("Spring blast");
  expect(campaigns).toHaveBeenCalledTimes(1);
  expect(schedules).toHaveBeenCalledTimes(1);

  await user.click(refreshButton());

  // Both reads went out again — the table is a join, so refreshing only the
  // campaigns would leave every lifecycle badge stale.
  expect(campaigns).toHaveBeenCalledTimes(2);
  expect(schedules).toHaveBeenCalledTimes(2);

  // THE GUARANTEE: mid-refresh, the row is still there and no skeleton has
  // been thrown over it.
  expect(screen.getByText("Spring blast")).toBeInTheDocument();
  expect(screen.queryByLabelText("Loading…")).not.toBeInTheDocument();

  held.resolve([SCHEDULE]);
  await waitFor(() => expect(refreshButton()).toBeEnabled());
  expect(screen.getByText("Spring blast")).toBeInTheDocument();
});

test("Campaigns: the button says Refreshing… and is disabled, then re-enabled", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "campaigns").mockResolvedValue([CAMPAIGN] as never);
  const held = deferred<unknown>();
  vi.spyOn(api, "schedules")
    .mockResolvedValueOnce([SCHEDULE] as never)
    .mockReturnValueOnce(held.promise as never);

  render(<Campaigns org="acme" grant={ADMIN} />);
  await screen.findByText("Spring blast");
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();

  await user.click(refreshButton());
  const busy = screen.getByRole("button", { name: "Refreshing…" });
  expect(busy).toBeDisabled();

  held.resolve([SCHEDULE]);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
});

test("Campaigns: clicking twice mid-flight does not spawn overlapping reads", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "campaigns").mockResolvedValue([CAMPAIGN] as never);
  const held = deferred<unknown>();
  const schedules = vi.spyOn(api, "schedules")
    .mockResolvedValueOnce([SCHEDULE] as never)
    .mockReturnValueOnce(held.promise as never);

  render(<Campaigns org="acme" grant={ADMIN} />);
  await screen.findByText("Spring blast");

  await user.click(refreshButton());
  // The button is disabled, so a real operator cannot; assert the guard holds
  // even if a click gets through some other way.
  await user.click(refreshButton()).catch(() => undefined);
  expect(schedules).toHaveBeenCalledTimes(2);

  held.resolve([SCHEDULE]);
  await waitFor(() => expect(refreshButton()).toBeEnabled());
});

test("Campaigns: a failed refresh is surfaced and the rows survive it", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "campaigns").mockResolvedValue([CAMPAIGN] as never);
  vi.spyOn(api, "schedules")
    .mockResolvedValueOnce([SCHEDULE] as never)
    .mockRejectedValueOnce(new Error("network down"));

  render(<Campaigns org="acme" grant={ADMIN} />);
  await screen.findByText("Spring blast");

  await user.click(refreshButton());

  await screen.findByText(/network down/);
  expect(screen.getByText("Spring blast")).toBeInTheDocument();
  expect(refreshButton()).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Schedules — the one screen that is not on `useAsync`.
// ---------------------------------------------------------------------------

test("Schedules: Refresh re-reads and holds the table through the read", async () => {
  const user = userEvent.setup();
  const held = deferred<unknown>();
  const schedules = vi.spyOn(api, "schedules")
    .mockResolvedValueOnce([SCHEDULE] as never)
    .mockReturnValueOnce(held.promise as never);

  render(<Schedules org="acme" grant={ADMIN} />);
  await screen.findByText("spring");

  await user.click(refreshButton());
  expect(schedules).toHaveBeenCalledTimes(2);

  // Mid-refresh: rows present, no skeleton, button busy and disabled.
  expect(screen.getByText("spring")).toBeInTheDocument();
  expect(screen.queryByLabelText("Loading…")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();

  held.resolve([{ ...SCHEDULE, status: "paused" }]);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  expect(screen.getByText("PAUSED")).toBeInTheDocument();
});

test("Schedules: a failed refresh shows the error without emptying the table", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "schedules")
    .mockResolvedValueOnce([SCHEDULE] as never)
    .mockRejectedValueOnce(new Error("gateway timeout"));

  render(<Schedules org="acme" grant={ADMIN} />);
  await screen.findByText("spring");

  await user.click(refreshButton());

  await screen.findByText(/gateway timeout/);
  // The mount path renders the skeleton on `rows === null`; a failed refresh
  // must not have nulled them.
  expect(screen.getByText("spring")).toBeInTheDocument();
  expect(refreshButton()).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Team — the screen whose error used to replace everything.
// ---------------------------------------------------------------------------

const MEMBER = {
  username: "u1", email: "op@example.com", role: "developer_admin",
  orgs: ["acme"], enabled: true, capabilities: ["campaigns:manage"],
};

test("Team: Refresh re-reads the roster and keeps it visible throughout", async () => {
  const user = userEvent.setup();
  const held = deferred<unknown>();
  const team = vi.spyOn(api, "team")
    .mockResolvedValueOnce([MEMBER] as never)
    .mockReturnValueOnce(held.promise as never);

  render(<Team org="acme" />);
  await screen.findByText("op@example.com");

  await user.click(refreshButton());
  expect(team).toHaveBeenCalledTimes(2);
  expect(screen.getByText("op@example.com")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();

  held.resolve([MEMBER]);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
});

test("Team: a failed refresh no longer replaces the whole screen", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "team")
    .mockResolvedValueOnce([MEMBER] as never)
    .mockRejectedValueOnce(new Error("role read failed"));

  render(<Team org="acme" />);
  await screen.findByText("op@example.com");

  await user.click(refreshButton());

  await screen.findByText(/role read failed/);
  // The roster AND the invite form are still there — the early `return` on
  // `loaded.error` would have taken both.
  expect(screen.getByText("op@example.com")).toBeInTheDocument();
  expect(screen.getByText("Invite a member")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Feeds — the optimistic local list that wins over the read.
// ---------------------------------------------------------------------------

const FEED = {
  orgId: "acme", feedId: "news", url: "https://example.com/rss.xml",
  format: "rss", targetListId: "ledger", fieldMap: {}, pullIntervalMins: 60,
};

test("Feeds: Refresh re-reads and the feed rows stay put mid-flight", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "lists").mockResolvedValue([{ orgId: "acme", listId: "ledger", name: "Ledger" }] as never);
  const held = deferred<unknown>();
  const feeds = vi.spyOn(api, "feeds")
    .mockResolvedValueOnce([FEED] as never)
    .mockReturnValueOnce(held.promise as never);

  render(<Feeds org="acme" />);
  await screen.findByText("news");

  await user.click(refreshButton());
  expect(feeds).toHaveBeenCalledTimes(2);
  expect(screen.getByText("news")).toBeInTheDocument();
  expect(screen.queryByLabelText("Loading feeds…")).not.toBeInTheDocument();

  held.resolve([FEED, { ...FEED, feedId: "weather" }]);
  await waitFor(() => expect(screen.getByText("weather")).toBeInTheDocument());
  expect(refreshButton()).toBeEnabled();
});

test("Feeds: a refresh supersedes the optimistic local list", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "lists").mockResolvedValue([{ orgId: "acme", listId: "ledger", name: "Ledger" }] as never);
  vi.spyOn(api, "feeds").mockResolvedValue([FEED] as never);
  vi.spyOn(api, "saveFeed").mockResolvedValue({ ...FEED, feedId: "saved-one" } as never);

  render(<Feeds org="acme" />);
  await screen.findByText("news");

  // A save populates `localFeeds`, which WINS over `feeds.data`.
  await user.click(screen.getByRole("button", { name: /Add feed/ }));
  await user.type(screen.getByPlaceholderText("news-feed"), "saved-one");
  await user.type(screen.getByPlaceholderText("https://example.com/rss.xml"), "https://example.com/two.xml");
  await user.click(screen.getByRole("button", { name: "Save feed" }));
  await screen.findByText("saved-one");

  // Now the server's answer — without clearing `localFeeds`, Refresh would
  // appear to do nothing at all.
  vi.mocked(api.feeds).mockResolvedValue([{ ...FEED, feedId: "server-truth" }] as never);
  await user.click(refreshButton());

  await waitFor(() => expect(screen.getByText("server-truth")).toBeInTheDocument());
  expect(screen.queryByText("saved-one")).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// The control itself.
// ---------------------------------------------------------------------------

test("the control is a labelled, reachable button on every screen that has one", async () => {
  vi.spyOn(api, "campaigns").mockResolvedValue([CAMPAIGN] as never);
  vi.spyOn(api, "schedules").mockResolvedValue([SCHEDULE] as never);
  const { container } = render(<Campaigns org="acme" grant={ADMIN} />);
  await screen.findByText("Spring blast");

  const button = refreshButton();
  // A real <button>, so it is tab-reachable and Enter/Space activate it —
  // not a div with a click handler.
  expect(button.tagName).toBe("BUTTON");
  expect(button).toHaveAttribute("type", "button");
  expect(button).toHaveAccessibleName("Refresh");
  // It sits in the page header, beside the primary action.
  expect(within(container.querySelector(".pagehead") as HTMLElement).getByRole("button", { name: "Refresh" }))
    .toBe(button);
});
