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
import { Compose } from "./App.js";
import { api } from "./api.js";

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
