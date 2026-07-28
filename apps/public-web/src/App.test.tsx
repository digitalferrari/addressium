/**
 * Public signup form (#98) — the critical top-of-funnel flow: entering an email
 * posts a double-opt-in signup and surfaces the "check your inbox" confirmation.
 */
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HONEYPOT_FIELD } from "@addressium/core";
import { isHoneypotTripped } from "@addressium/domain";
import { SignupForm } from "./App.js";

afterEach(cleanup);

test("submitting the form posts a signup and shows the confirmation message", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: "pending" }),
    text: async () => "",
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<SignupForm defaultList="ledger" />);
  await userEvent.type(screen.getByPlaceholderText("you@example.com"), "reader@example.com");
  await userEvent.click(screen.getByRole("button", { name: /subscribe/i }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toMatch(/\/signup$/);
  expect(init.method).toBe("POST");
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ email: "reader@example.com", listId: "ledger" });

  await screen.findByText(/check your inbox to confirm/i);
  vi.unstubAllGlobals();
});

test("the subscribe button is disabled until an email is entered", async () => {
  render(<SignupForm defaultList="ledger" />);
  expect(screen.getByRole("button", { name: /subscribe/i })).toBeDisabled();
});

/**
 * Honeypot on the hosted page (#230).
 *
 * The server check and the embed widget both had this; the page addressium
 * itself hosts and links from the subscriber directory did not, so the trap
 * could never trip on the one public page an operator is most likely to deploy
 * and least likely to probe as an attacker. The asymmetry is what made it easy
 * to miss — anyone testing the embed saw the protection work.
 */
test("the hosted page renders the trap field and posts it", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: "pending" }),
    text: async () => "",
  });
  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(<SignupForm defaultList="ledger" />);
  const trap = container.querySelector<HTMLInputElement>(`input[name="${HONEYPOT_FIELD}"]`);
  expect(trap).not.toBeNull();

  // Off-screen rather than hidden: a bot that skips display:none inputs still
  // fills this one. Humans are kept out by aria-hidden and tabindex instead.
  expect(trap!.getAttribute("aria-hidden")).toBe("true");
  expect(trap!.tabIndex).toBe(-1);
  expect(trap!.autocomplete).toBe("off");
  expect(trap!.style.position).toBe("absolute");
  expect(parseInt(trap!.style.left, 10)).toBeLessThan(-1000);

  await userEvent.type(screen.getByPlaceholderText("you@example.com"), "reader@example.com");
  await userEvent.click(screen.getByRole("button", { name: /subscribe/i }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  // Present and empty for a real human. The server reads absence and empty
  // identically, but sending the field is what makes a filled one detectable.
  const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
  expect(body).toHaveProperty(HONEYPOT_FIELD, "");
  vi.unstubAllGlobals();
});

test("a filled trap is still submitted, so the server can silently drop it", async () => {
  // The client must NOT block the submit itself: a bot that sees a client-side
  // rejection learns the trap exists. It posts normally and gets the same
  // 202 pending a human gets, having written nothing.
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: "pending" }),
    text: async () => "",
  });
  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(<SignupForm defaultList="ledger" />);
  const trap = container.querySelector<HTMLInputElement>(`input[name="${HONEYPOT_FIELD}"]`)!;
  await userEvent.type(trap, "http://spam.example");
  await userEvent.type(screen.getByPlaceholderText("you@example.com"), "bot@example.com");
  await userEvent.click(screen.getByRole("button", { name: /subscribe/i }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
  expect(isHoneypotTripped(body)).toBe(true);
  vi.unstubAllGlobals();
});
