import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api, type PreferenceView } from "./api.js";
import { Preferences } from "./App.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const view: PreferenceView = {
  orgId: "acme",
  email: "reader@example.com",
  rows: [
    { listId: "daily", name: "Daily briefing", subscribed: true, status: "confirmed" },
    { listId: "weekend", name: "Weekend edition", description: "A slower read.", subscribed: false },
  ],
};

describe("subscriber preference centre", () => {
  test("loads the token-scoped subscriptions and saves only changed rows", async () => {
    vi.spyOn(api, "preferences").mockResolvedValue(view);
    const update = vi.spyOn(api, "updatePreferences").mockResolvedValue({
      unsubscribed: ["daily"], resubscribed: [], rejected: [],
      view: { ...view, rows: view.rows.map((row) => row.listId === "daily" ? { ...row, subscribed: false, status: "unsubscribed" } : row) },
    });

    const user = userEvent.setup();
    render(<Preferences token="management-token" />);
    await screen.findByText("reader@example.com");
    await user.click(screen.getByLabelText("Daily briefing"));
    await user.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith("management-token", [{ listId: "daily", subscribed: false }]));
    expect(screen.getByText("Your preferences have been saved.")).toBeTruthy();
  });

  test("without a token, requests a management link without revealing account existence", async () => {
    const request = vi.spyOn(api, "requestPreferences").mockResolvedValue({
      status: "sent", message: "If that address is subscribed, a link is on its way.",
    });
    const user = userEvent.setup();
    render(<Preferences />);
    await user.type(screen.getByPlaceholderText("you@example.com"), "reader@example.com");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("reader@example.com"));
    expect(screen.getByText(/If that address is subscribed/)).toBeTruthy();
  });
});
