/**
 * Compose — switching body mode must not lose a draft silently (#249).
 *
 * `bodyMode` selects between three independent state slots. Switching keeps what
 * was typed, so nothing is destroyed — but the submit path reads ONLY the
 * selected slot, and the screen said nothing about the other two. The operator's
 * model is "my draft is here"; the send disagreed, and the disagreement was
 * invisible until the campaign went out with the wrong body.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Compose } from "./screens/Compose.js";
import { api } from "./api.js";

const compileMjml = vi.hoisted(() => vi.fn((source: string) => ({ html: `<compiled>${source}</compiled>`, errors: [] })));
vi.mock("mjml-browser", () => ({ default: compileMjml }));

beforeEach(() => {
  vi.spyOn(api, "lists").mockResolvedValue([
    { listId: "ledger", name: "The Ledger" },
  ] as never);
  vi.spyOn(api, "templates").mockResolvedValue([] as never);
  vi.spyOn(api, "segments").mockResolvedValue([] as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openCompose() {
  const user = userEvent.setup();
  render(<Compose org="acme" onScheduled={() => undefined} />);
  await screen.findByText(/The Ledger/);
  return user;
}

const modeRadio = (name: RegExp) => screen.getByRole("radio", { name });

test("a draft left in another mode is named, not silently ignored", async () => {
  const user = await openCompose();
  await user.click(modeRadio(/Raw HTML/));
  await user.type(screen.getByPlaceholderText(/Hello/), "<h1>Real draft</h1>");

  // Switching away is legitimate — the operator may be looking. What was
  // missing is any signal that the text they just typed is no longer the body.
  await user.click(modeRadio(/MJML/));
  // The banner names the mode holding the draft AND the mode that will be sent,
  // because "you have unsent work somewhere" is not actionable on its own.
  const banner = screen.getByText(/not sent/);
  expect(banner).toHaveTextContent(/Sending the\s*MJML\s*body/);
  expect(banner).toHaveTextContent(/Raw HTML/);
  expect(screen.getByText(/has a draft/)).toBeInTheDocument();
});

test("the text itself survives the switch — it is kept, not discarded", async () => {
  // The original report assumed the body was destroyed. It is not: the slots are
  // separate state. Asserting the survival keeps a future "fix" from adding a
  // confirm-and-clear that would make the described bug real.
  const user = await openCompose();
  await user.click(modeRadio(/Raw HTML/));
  await user.type(screen.getByPlaceholderText(/Hello/), "<h1>Keep me</h1>");
  await user.click(modeRadio(/MJML/));
  await user.click(modeRadio(/Raw HTML/));
  expect(screen.getByPlaceholderText(/Hello/)).toHaveValue("<h1>Keep me</h1>");
});

test("no warning when only the selected mode holds anything", async () => {
  // A banner on every compose is a banner nobody reads.
  const user = await openCompose();
  await user.click(modeRadio(/Raw HTML/));
  await user.type(screen.getByPlaceholderText(/Hello/), "<h1>Only draft</h1>");
  expect(screen.queryByText(/not sent/)).toBeNull();
  expect(screen.queryByText(/has a draft/)).toBeNull();
});

test("a half-finished block still counts as a draft worth warning about", async () => {
  // "Filled" is deliberately not "valid": an editorial block with a label and no
  // url is unfinished work, and losing track of it is the same failure.
  const user = await openCompose();
  await user.type(screen.getByPlaceholderText(/merge tags allowed/), "half a paragraph");
  await user.click(modeRadio(/MJML/));
  expect(screen.getByText(/not sent/)).toBeInTheDocument();
});

test.each(["raw_html", "mjml", "visual"] as const)("%s template loads a copy and schedules the edited snapshot for recurring sends", async (mode) => {
  const saved = { orgId: "acme", templateId: "daily", name: "Daily", mode, source: "Saved body", version: 1 };
  vi.mocked(api.templates).mockResolvedValue([saved] as never);
  const schedule = vi.spyOn(api, "scheduleCampaign").mockResolvedValue({ scheduleId: "daily", status: "active" } as never);
  const saveTemplate = vi.spyOn(api, "saveTemplate");
  const user = await openCompose();
  await user.click(modeRadio(mode === "raw_html" ? /Raw HTML/ : /MJML/));
  const option = await screen.findByRole("option", { name: "Daily (daily)" });
  await user.selectOptions(option.closest("select")!, "daily");
  const body = screen.getByDisplayValue("Saved body");
  await user.clear(body);
  await user.type(body, "Campaign edit");
  expect(saved.source).toBe("Saved body");

  // A later template save cannot change the already copied draft.
  saved.source = "Later template revision";
  await user.click(modeRadio(/Blocks/));
  await user.click(modeRadio(mode === "raw_html" ? /Raw HTML/ : /MJML/));
  expect(screen.getByDisplayValue("Campaign edit")).toBeInTheDocument();
  expect(screen.getByText(/later template changes do not update this draft/)).toHaveTextContent(/including for recurring sends/);
  await user.type(screen.getByPlaceholderText(/daily-2026/), "daily-send");
  await user.type(screen.getByPlaceholderText("Subject line"), "Daily news");
  await user.click(screen.getByRole("radio", { name: "Recurring" }));
  await user.click(screen.getByRole("button", { name: "Schedule" }));
  await screen.findByText(/Scheduled "daily"/);
  expect(schedule).toHaveBeenCalledWith(expect.objectContaining({
    template: mode === "raw_html" ? { html: "Campaign edit" } : { mjmlHtml: "<compiled>Campaign edit</compiled>" },
    when: { type: "recurring", cron: "cron(0 13 * * ? *)" },
  }));
  expect(saveTemplate).not.toHaveBeenCalled();
});
