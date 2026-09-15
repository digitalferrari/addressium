/**
 * SES account suppression import — the console surface (#251).
 *
 * `POST /orgs/{org}/import/suppression` was built, routed and granted
 * `ListSuppressedDestinations`, and nothing in the console called it. The step
 * has to run BEFORE the subscriber import: a subscriber base can be re-exported
 * from the old provider at any time, but a two-year-old hard bounce exists only
 * on the SES account list, and mailing those addresses is the reputation event
 * the migration was meant to avoid.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Subscribers } from "./screens/Subscribers.js";
import { api, type SuppressionImportReport } from "./api.js";
import type { Grant } from "./rbac.js";

const ADMIN: Grant = { role: "developer_admin", orgs: "*" };
const EDITOR: Grant = { role: "editor", orgs: ["acme"] };

const REPORT: SuppressionImportReport = {
  read: 120,
  written: 117,
  bySource: { bounce: 100, complaint: 17 },
  unmapped: [{ email: "odd@x.test", reason: "SOMETHING_ELSE" }],
  malformed: 2,
  dryRun: false,
};

let importSuppression: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.spyOn(api, "subscribers").mockResolvedValue({ rows: [] } as never);
  vi.spyOn(api, "suppressions").mockResolvedValue([] as never);
  // The handler echoes the flag it acted on, so the mock does too — a fixed
  // `dryRun` would let the screen mislabel a real write as a rehearsal.
  importSuppression = vi.fn(async (_org: string, dryRun: boolean) => ({ ...REPORT, dryRun }));
  vi.spyOn(api, "importSuppression").mockImplementation(importSuppression as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a dry run reads the account list and writes nothing", async () => {
  const user = userEvent.setup();
  render(<Subscribers org="acme" grant={ADMIN} />);
  await user.click(await screen.findByRole("button", { name: /Dry run/ }));

  expect(importSuppression).toHaveBeenCalledWith("acme", true);
  expect(await screen.findByText(/Dry run — nothing was written/)).toBeInTheDocument();
});

test("the import writes, and reports what it read against what it wrote", async () => {
  const user = userEvent.setup();
  render(<Subscribers org="acme" grant={ADMIN} />);
  await user.click(await screen.findByRole("button", { name: /^Import$/ }));

  expect(importSuppression).toHaveBeenCalledWith("acme", false);
  expect(await screen.findByText(/Read 120, wrote 117/)).toBeInTheDocument();
});

test("an unmapped reason is listed as still-mailable, not counted as skipped", async () => {
  // The whole point of surfacing these: "1 skipped" reads as housekeeping, and
  // what it means is "1 address we will now mail".
  const user = userEvent.setup();
  render(<Subscribers org="acme" grant={ADMIN} />);
  await user.click(await screen.findByRole("button", { name: /^Import$/ }));

  expect(await screen.findByText(/stay mailable/)).toBeInTheDocument();
  expect(screen.getByText("odd@x.test")).toBeInTheDocument();
  expect(screen.getByText("SOMETHING_ELSE")).toBeInTheDocument();
});

test("a role without suppression:manage is not shown a button that would 403", async () => {
  // These entries are global, bulk, and have no bulk way back — the server keeps
  // the route developer_admin-only, and the console mirrors that rather than
  // offering an action the caller cannot take.
  render(<Subscribers org="acme" grant={EDITOR} />);
  await screen.findByText(/Suppression list/);
  expect(screen.queryByRole("button", { name: /Dry run/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Import$/ })).toBeNull();
});
