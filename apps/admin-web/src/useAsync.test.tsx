/**
 * `useAsync.refetch` — the hook behind every Refresh button.
 *
 * The whole point of the control is that pressing it does NOT blank the screen,
 * and the hook is where that is decided: the deps path clears `data` (screens
 * depend on that to avoid showing org A's rows under org B), a refetch keeps it.
 * These tests pin both halves, because the failure mode is silent — a refresh
 * that clears `data` still "works", it just throws a shimmer over a correct
 * table every time it is pressed.
 */
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useAsync } from "./useAsync.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A promise whose settlement this test controls, so a read can be held open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function Probe({ fn, dep }: { fn: () => Promise<string>; dep: string }) {
  const { data, error, loading, refreshing, refetch } = useAsync(fn, [dep]);
  return (
    <div>
      <span data-testid="data">{data ?? "none"}</span>
      <span data-testid="error">{error ?? "none"}</span>
      <span data-testid="flags">{`loading=${loading} refreshing=${refreshing}`}</span>
      <button onClick={() => void refetch()}>go</button>
    </div>
  );
}

const text = (id: string) => screen.getByTestId(id).textContent;

test("a refetch keeps `data` on screen and never sets `loading`", async () => {
  const second = deferred<string>();
  const fn = vi.fn()
    .mockResolvedValueOnce("first rows")
    .mockReturnValueOnce(second.promise);
  render(<Probe fn={fn} dep="a" />);
  await waitFor(() => expect(text("data")).toBe("first rows"));

  await act(async () => { screen.getByText("go").click(); });

  // Mid-refresh: the rows an operator is looking at are still there, and
  // `loading` — what every skeleton is keyed on — has NOT flipped back on.
  expect(text("data")).toBe("first rows");
  expect(text("flags")).toBe("loading=false refreshing=true");

  await act(async () => { second.resolve("fresh rows"); });
  expect(text("data")).toBe("fresh rows");
  expect(text("flags")).toBe("loading=false refreshing=false");
});

test("a failed refetch reports the error and keeps the rows", async () => {
  const fn = vi.fn()
    .mockResolvedValueOnce("first rows")
    .mockRejectedValueOnce(new Error("boom"));
  render(<Probe fn={fn} dep="a" />);
  await waitFor(() => expect(text("data")).toBe("first rows"));

  await act(async () => { screen.getByText("go").click(); });

  await waitFor(() => expect(text("error")).toContain("boom"));
  expect(text("data")).toBe("first rows");
  expect(text("flags")).toBe("loading=false refreshing=false");
});

test("a successful refetch clears a stale error", async () => {
  const fn = vi.fn()
    .mockResolvedValueOnce("rows")
    .mockRejectedValueOnce(new Error("boom"))
    .mockResolvedValueOnce("rows again");
  render(<Probe fn={fn} dep="a" />);
  await waitFor(() => expect(text("data")).toBe("rows"));

  await act(async () => { screen.getByText("go").click(); });
  await waitFor(() => expect(text("error")).toContain("boom"));

  await act(async () => { screen.getByText("go").click(); });
  await waitFor(() => expect(text("data")).toBe("rows again"));
  expect(text("error")).toBe("none");
});

test("a second refetch while one is in flight does not spawn a second read", async () => {
  const held = deferred<string>();
  const fn = vi.fn()
    .mockResolvedValueOnce("rows")
    .mockReturnValueOnce(held.promise);
  render(<Probe fn={fn} dep="a" />);
  await waitFor(() => expect(text("data")).toBe("rows"));

  await act(async () => { screen.getByText("go").click(); });
  await act(async () => { screen.getByText("go").click(); });
  await act(async () => { screen.getByText("go").click(); });

  // One mount read plus exactly one refresh — overlapping reads could land out
  // of order and leave the older response on screen.
  expect(fn).toHaveBeenCalledTimes(2);

  await act(async () => { held.resolve("fresh"); });
  expect(text("data")).toBe("fresh");
});

test("a deps change still clears `data` — the regression guard", async () => {
  // Screens rely on this: ImportMapper's `!batches.data`, Campaigns' per-cell
  // staleness and the Feeds org-switch reset all read a missing `data` as
  // "the new org's rows have not landed yet".
  const held = deferred<string>();
  const fn = vi.fn()
    .mockResolvedValueOnce("org A rows")
    .mockReturnValueOnce(held.promise);
  const view = render(<Probe fn={fn} dep="a" />);
  await waitFor(() => expect(text("data")).toBe("org A rows"));

  await act(async () => { view.rerender(<Probe fn={fn} dep="b" />); });

  expect(text("data")).toBe("none");
  expect(text("flags")).toBe("loading=true refreshing=false");
});

test("a refetch superseded by a deps change does not land on the new screen", async () => {
  const slowRefresh = deferred<string>();
  const fn = vi.fn()
    .mockResolvedValueOnce("org A rows")
    .mockReturnValueOnce(slowRefresh.promise)
    .mockResolvedValueOnce("org B rows");
  const view = render(<Probe fn={fn} dep="a" />);
  await waitFor(() => expect(text("data")).toBe("org A rows"));

  await act(async () => { screen.getByText("go").click(); });
  await act(async () => { view.rerender(<Probe fn={fn} dep="b" />); });
  await waitFor(() => expect(text("data")).toBe("org B rows"));

  // Org A's refresh answers late. It must be dropped, not painted over org B.
  await act(async () => { slowRefresh.resolve("org A, late"); });
  expect(text("data")).toBe("org B rows");
});
