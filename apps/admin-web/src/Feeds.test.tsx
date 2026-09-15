/**
 * Feeds — the article-pull configuration screen (#278).
 *
 * The design's table is Feed / Maps to / Last pulled / Items / Status. The
 * scheduler now carries `feedId` and records the result of each recurring pull
 * on the feed record, so these columns are real rather than illustrative.
 *
 * `pullIntervalMins` is likewise stored and read by nothing — the series cron is
 * what fires the pull — so it must not be presented as the effective schedule.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Feeds } from "./screens/Feeds.js";
import { api, type Feed } from "./api.js";

const LISTS = [
  { orgId: "acme", listId: "ledger", name: "The Morning Ledger" },
  { orgId: "acme", listId: "weekly", name: "Weekly Brief" },
];

const FEED: Feed = {
  orgId: "acme",
  feedId: "ledger-news",
  url: "https://example.com/rss.xml",
  format: "rss",
  targetListId: "ledger",
  fieldMap: { title: "article_title", link: "article_url" },
  pullIntervalMins: 60,
};

beforeEach(() => {
  vi.spyOn(api, "feeds").mockResolvedValue([FEED]);
  vi.spyOn(api, "lists").mockResolvedValue(LISTS as unknown as Awaited<ReturnType<typeof api.lists>>);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

async function renderFeeds() {
  render(<Feeds org="acme" />);
  await waitFor(() => expect(screen.getByText("ledger-news")).toBeTruthy());
}

test("renders the stored feed and resolves the target list to its name", async () => {
  await renderFeeds();
  const row = screen.getByText("ledger-news").closest("tr");
  expect(row).toBeTruthy();
  // "Maps to" is real: the list name, resolved from the loaded newsletters.
  expect(within(row as HTMLElement).getByText("The Morning Ledger")).toBeTruthy();
  // The field map is rendered from the stored record, not invented.
  expect(within(row as HTMLElement).getByText(/article_title/)).toBeTruthy();
  expect(screen.getByText(/example\.com\/rss\.xml/)).toBeTruthy();
});

test("a feed with no run yet reports an honest empty run state", async () => {
  await renderFeeds();
  const row = screen.getByText("ledger-news").closest("tr") as HTMLElement;
  expect(within(row).getAllByText("Not pulled yet")).toHaveLength(2);
  expect(within(row).getByText("—")).toBeTruthy();
  const text = row.textContent ?? "";
  expect(text).not.toMatch(/healthy|success|failed|error|just now|ago\b/i);
});

test("renders the last real pull result", async () => {
  vi.spyOn(api, "feeds").mockResolvedValue([{ ...FEED, lastPulledAt: "2026-09-15T12:00:00.000Z", lastItemCount: 7, lastStatus: "ok" }]);
  await renderFeeds();
  const row = screen.getByText("ledger-news").closest("tr") as HTMLElement;
  expect(within(row).getByText("7")).toBeTruthy();
  expect(within(row).getByText("OK")).toBeTruthy();
  expect(within(row).queryByText("Not pulled yet")).toBeNull();
});

test("does not present the stored pull interval as the effective schedule", async () => {
  await renderFeeds();
  const row = screen.getByText("ledger-news").closest("tr") as HTMLElement;
  // pullIntervalMins is read by nothing; the recurring campaign cron fires the
  // pull. The table must not claim the feed runs every 60 minutes.
  expect(row.textContent ?? "").not.toMatch(/every 60|60 min/i);
});

test("switching org does not leave the previous org's feeds on screen", async () => {
  // `localFeeds` is the post-save optimistic copy and takes precedence over the
  // fetched list. If the org effect does not clear it, org A's feeds render
  // under org B's header — a wrong-data display, not merely a stale one.
  const feeds = vi.spyOn(api, "feeds");
  feeds.mockResolvedValue([FEED]);
  vi.spyOn(api, "saveFeed").mockImplementation(async (body) => body as Feed);
  const view = render(<Feeds org="acme" />);
  await waitFor(() => expect(screen.getByText("ledger-news")).toBeTruthy());

  // Edit + save populates the optimistic `localFeeds` copy for org "acme".
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /edit/i }));
  await user.click(screen.getByRole("button", { name: /save feed/i }));
  await waitFor(() => expect(screen.getByText(/Feed saved/i)).toBeTruthy());

  feeds.mockResolvedValue([{ ...FEED, orgId: "other", feedId: "other-news", targetListId: "weekly" }]);
  view.rerender(<Feeds org="other" />);

  await waitFor(() => expect(screen.getByText("other-news")).toBeTruthy());
  expect(screen.queryByText("ledger-news")).toBeNull();
});

test("an org with no feeds gets an empty state, not a placeholder row", async () => {
  vi.spyOn(api, "feeds").mockResolvedValue([]);
  render(<Feeds org="acme" />);
  await waitFor(() => expect(screen.getByText(/No feeds configured yet/i)).toBeTruthy());
  expect(screen.queryByText("Not recorded")).toBeNull();
});
