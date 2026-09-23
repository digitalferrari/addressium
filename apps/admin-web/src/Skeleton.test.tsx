/**
 * Shimmer placeholders.
 *
 * These replaced a bare `<div className="muted">Loading…</div>` on 17 sites. A
 * screen reader must still hear "loading" exactly once per block — the failure
 * mode of a skeleton is announcing every stripe — and the shimmer must keep the
 * `.skeleton` class, since that is what carries both the animation and the
 * `prefers-reduced-motion` override in styles.css.
 */
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SkeletonCard, SkeletonKpi, SkeletonScreen, SkeletonTable } from "./Skeleton.js";

afterEach(() => cleanup());

test("a table skeleton announces itself once, not once per row", () => {
  render(<SkeletonTable rows={6} />);
  // One status region for the whole block.
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
});

test("a table skeleton renders the requested number of bars", () => {
  const { container } = render(<SkeletonTable rows={6} />);
  expect(container.querySelectorAll(".skeleton.sk-line")).toHaveLength(6);
});

test("row bars never collapse to nothing at high row counts", () => {
  // Widths taper, so without a floor a long table ends in invisible slivers.
  const { container } = render(<SkeletonTable rows={12} />);
  for (const el of container.querySelectorAll<HTMLElement>(".sk-line")) {
    expect(parseFloat(el.style.width)).toBeGreaterThanOrEqual(45);
  }
});

test("each variant keeps the .skeleton class that carries the animation", () => {
  for (const node of [<SkeletonTable key="t" />, <SkeletonKpi key="k" />, <SkeletonCard key="c" />]) {
    const { container, unmount } = render(node);
    expect(container.querySelector(".skeleton")).not.toBeNull();
    unmount();
  }
});

test("labels are customisable and reach the accessibility tree", () => {
  render(<SkeletonTable label="Loading trends…" />);
  expect(screen.getByLabelText("Loading trends…")).toBeTruthy();
});

test("the default screen placeholder is card-shaped", () => {
  // Every screen that used the old text rendered it where a card was about to
  // appear; a bare line made the page reflow when content arrived.
  const { container } = render(<SkeletonScreen />);
  expect(container.querySelector(".card")).not.toBeNull();
});
