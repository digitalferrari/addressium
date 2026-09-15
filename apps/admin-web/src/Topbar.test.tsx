import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Topbar } from "./Topbar.js";
import { api } from "./api.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("global search loads named resources and navigates to the matching screen", async () => {
  vi.spyOn(api, "search").mockResolvedValue({
    results: [{ kind: "campaigns", id: "weekly-1", label: "Weekly edition" }],
  });
  const onNavigate = vi.fn();
  const user = userEvent.setup();
  render(<Topbar orgName="Acme" org="acme" view="dashboard" orgEnv="prod" claims={{}} onNavigate={onNavigate} />);

  await user.type(screen.getByRole("textbox", { name: "Search console" }), "weekly");
  const result = await screen.findByText("Weekly edition");
  expect(result.closest("button")).not.toBeNull();
  expect(api.search).toHaveBeenCalledWith("acme", "weekly");
  await user.click(result);
  expect(onNavigate).toHaveBeenCalledWith("campaigns");
});

test("search does not query for a one-character term", async () => {
  const search = vi.spyOn(api, "search").mockResolvedValue({ results: [] });
  const user = userEvent.setup();
  render(<Topbar orgName="Acme" org="acme" view="dashboard" orgEnv="prod" claims={{}} onNavigate={vi.fn()} />);
  await user.type(screen.getByRole("textbox", { name: "Search console" }), "a");
  await waitFor(() => expect(search).not.toHaveBeenCalled());
});
