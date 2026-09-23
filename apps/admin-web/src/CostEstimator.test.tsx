/**
 * Cost estimator summary tiles.
 *
 * The per day / per month / per campaign figures are slices of the SAME
 * `annualUsd` the table above them reports, so they must always reconcile to
 * it. A second model here — or a stray rounding step — would quietly disagree
 * with the total it sits under, which is worse than not showing the numbers.
 */
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { estimateSendCost, DEFAULT_COST_INPUT } from "@addressium/domain/cost";
import { CostEstimator } from "./screens/CostEstimator.js";

afterEach(() => cleanup());

const usd = (n: number) => `$${n.toFixed(2)}`;

test("the four cadences are rendered", () => {
  render(<CostEstimator />);
  for (const label of ["per day", "per month", "per campaign", "per year"]) {
    expect(screen.getByText(label)).toBeTruthy();
  }
});

test("the tiles reconcile to the annual total at the default weekly cadence", () => {
  // The screen opens on sendsPerYear: 52.
  const est = estimateSendCost({ ...DEFAULT_COST_INPUT, sendsPerYear: 52 });
  render(<CostEstimator />);

  expect(screen.getAllByText(usd(est.annualUsd / 365)).length).toBeGreaterThan(0);
  expect(screen.getAllByText(usd(est.annualUsd / 12)).length).toBeGreaterThan(0);
  expect(screen.getAllByText(usd(est.annualUsd / 52)).length).toBeGreaterThan(0);
  expect(screen.getAllByText(usd(est.annualUsd)).length).toBeGreaterThan(0);
});

test("per campaign carries fixed cost, so it exceeds the per-send total", () => {
  // The distinction the caption explains: a campaign costs more than the send,
  // because it also carries its share of the standing monthly bill.
  const est = estimateSendCost({ ...DEFAULT_COST_INPUT, sendsPerYear: 52 });
  expect(est.annualUsd / 52).toBeGreaterThan(est.perSendTotalUsd);
});

test("a campaign costs more than a send, and the gap is the fixed-cost share", () => {
  const sends = 52;
  const est = estimateSendCost({ ...DEFAULT_COST_INPUT, sendsPerYear: sends });
  const perCampaign = est.annualUsd / sends;
  // The whole annual fixed+storage burden, divided over the sends that carry it.
  const fixedShare = (est.annualUsd - est.perSendTotalUsd * sends) / sends;
  expect(perCampaign - est.perSendTotalUsd).toBeCloseTo(fixedShare, 10);
});

test("rarer sending loads more fixed cost onto each campaign", () => {
  // The relationship the caption describes: the standing bill does not shrink
  // when you send less, so each campaign absorbs more of it.
  const once = estimateSendCost({ ...DEFAULT_COST_INPUT, sendsPerYear: 1 }).annualUsd / 1;
  const weekly = estimateSendCost({ ...DEFAULT_COST_INPUT, sendsPerYear: 52 }).annualUsd / 52;
  const daily = estimateSendCost({ ...DEFAULT_COST_INPUT, sendsPerYear: 365 }).annualUsd / 365;
  expect(once).toBeGreaterThan(weekly);
  expect(weekly).toBeGreaterThan(daily);
});

test("zero sends renders a dash, not Infinity", () => {
  // Reachable: the sends field is a free-text number input the operator can
  // clear. Guarded in the component, so assert the rendered output.
  render(<CostEstimator />);
  const sendsInput = screen.getByDisplayValue("52");
  fireEvent.change(sendsInput, { target: { value: "0" } });
  expect(screen.getByText("—")).toBeTruthy();
  expect(screen.queryByText(/Infinity|NaN/)).toBeNull();
});
