/**
 * The top-edge indeterminate bar (#294).
 *
 * Skeletons say which block is waiting; this says the app is waiting at all —
 * the thing someone checks when a screen looks frozen.
 */
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { TopProgress } from "./TopProgress.js";
import { beginRequest, endRequest, resetPending } from "./pending.js";

afterEach(() => { cleanup(); resetPending(); });

test("absent when idle, present while a request is in flight", () => {
  render(<TopProgress />);
  expect(screen.queryByRole("progressbar")).toBeNull();

  act(() => beginRequest());
  expect(screen.getByRole("progressbar")).toBeInTheDocument();

  act(() => endRequest());
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("stays visible until the LAST concurrent request finishes", () => {
  // A counter, not a boolean. Screens run several useAsync calls at once, and
  // the bar must not vanish when the first one lands while others are pending.
  render(<TopProgress />);
  act(() => { beginRequest(); beginRequest(); beginRequest(); });
  expect(screen.getByRole("progressbar")).toBeInTheDocument();

  act(() => { endRequest(); endRequest(); });
  expect(screen.getByRole("progressbar")).toBeInTheDocument();

  act(() => endRequest());
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("an extra end does not leave the bar stuck on", () => {
  // A superseded refetch can settle twice. Without the floor the count goes
  // negative and every later request leaves the bar permanently visible.
  render(<TopProgress />);
  act(() => { beginRequest(); endRequest(); endRequest(); endRequest(); });
  expect(screen.queryByRole("progressbar")).toBeNull();

  act(() => beginRequest());
  expect(screen.getByRole("progressbar")).toBeInTheDocument();
  act(() => endRequest());
  expect(screen.queryByRole("progressbar")).toBeNull();
});
