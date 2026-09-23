/**
 * Campaign report — every counter the API returns (#253).
 *
 * `campaignReport` computes and returns ten counters. The screen rendered five
 * and discarded the rest, including `delivered` — the denominator an operator
 * reasons about — and `renderingFailures`, the only counter here that points at
 * OUR bug (an unresolved merge tag) rather than a recipient's mailbox. The data
 * was already on the wire; nothing rendered it.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Report } from "./screens/Report.js";
import { api, type CampaignReport } from "./api.js";
import type { Grant } from "./rbac.js";

const GRANT: Grant = { role: "developer_admin", orgs: "*" };

/** Every counter distinct, so a KPI reading the wrong field is visible. */
const REPORT: CampaignReport = {
  campaignId: "daily-2026-07-21",
  counters: {
    sent: 1000,
    delivered: 940,
    opens: 310,
    clicks: 120,
    bounces: 41,
    complaints: 3,
    unsubscribes: 17,
    rejects: 6,
    renderingFailures: 8,
    deliveryDelays: 22,
  },
  rates: { openRate: 0.31, clickRate: 0.12, bounceRate: 0.041, complaintRate: 0.003 },
  clickMap: { sent: 1000, rows: [] },
};

beforeEach(() => {
  vi.spyOn(api, "campaigns").mockResolvedValue([
    { campaignId: "daily-2026-07-21", subject: "The Ledger" },
  ] as never);
  vi.spyOn(api, "report").mockResolvedValue(REPORT as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function loadReport() {
  const user = userEvent.setup();
  render(<Report org="acme" grant={GRANT} />);
  await user.selectOptions(await screen.findByLabelText("Campaign"), "daily-2026-07-21");
  await user.click(screen.getByRole("button", { name: "Load" }));
  await screen.findByText("1000");
}

test("renders the counters the report already returned, not a subset", async () => {
  await loadReport();
  // `delivered` is not `sent`: SES accepting a message is not a mailbox
  // receiving it, and the gap between them is the whole point of the counter.
  expect(screen.getByText("940")).toBeInTheDocument();
  expect(screen.getByText("delivered")).toBeInTheDocument();
  expect(screen.getByText("17")).toBeInTheDocument();
  expect(screen.getByText("unsubscribes")).toBeInTheDocument();
  expect(screen.getByText("6")).toBeInTheDocument();
  expect(screen.getByText("rejects")).toBeInTheDocument();
  expect(screen.getByText("22")).toBeInTheDocument();
  expect(screen.getByText("delivery delays")).toBeInTheDocument();
});

test("a rendering failure is shown even though it is not a recipient problem", async () => {
  // This one counts merge tags that did not resolve. It was the counter most
  // worth surfacing and the one most easily dropped, because it is never what
  // an operator goes to the report looking for.
  await loadReport();
  expect(screen.getByText("rendering failures")).toBeInTheDocument();
  expect(screen.getByText("8")).toBeInTheDocument();
});

test("a zero counter still renders — absence is not the same as none", async () => {
  // A KPI that appears only when nonzero is one nobody knows to look for, so
  // "0 rendering failures" has to be readable as a fact rather than inferred
  // from a missing tile.
  vi.mocked(api.report).mockResolvedValue({
    ...REPORT,
    counters: { ...REPORT.counters, renderingFailures: 0, rejects: 0 },
  } as never);
  await loadReport();
  expect(screen.getByText("rendering failures")).toBeInTheDocument();
  expect(screen.getByText("rejects")).toBeInTheDocument();
});
