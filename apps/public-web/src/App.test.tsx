/**
 * Public signup form (#98) — the critical top-of-funnel flow: entering an email
 * posts a double-opt-in signup and surfaces the "check your inbox" confirmation.
 */
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
