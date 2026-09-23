import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./screens/Settings.js";
import { api } from "./api.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function meta() {
  vi.spyOn(api, "orgMeta").mockResolvedValue({
    orgId: "acme", name: "Acme", environment: "dev", setupComplete: false,
    domains: ["news.example.com"], magicLinkEnabled: true,
  });
}

test("Settings reads SES independently of org metadata and preserves unknown status", async () => {
  vi.spyOn(api, "orgMeta").mockRejectedValue(new Error("Metadata unavailable"));
  const live = vi.spyOn(api, "sendingIdentity").mockResolvedValue({
    orgId: "acme", account: { reason: "SES unavailable" }, domains: [],
  });
  render(<Settings org="acme" grant={{ role: "developer_admin", orgs: "*" }} />);
  expect(await screen.findByText("Could not determine")).toBeInTheDocument();
  expect(screen.getByText(/Metadata unavailable/)).toBeInTheDocument();
  expect(screen.queryByText("Can send")).not.toBeInTheDocument();
  expect(live).toHaveBeenCalledWith("acme");
});

test("analysts see domain metadata without requesting account SES state", async () => {
  meta();
  const live = vi.spyOn(api, "sendingIdentity");
  render(<Settings org="acme" grant={{ role: "analyst", orgs: ["acme"] }} />);
  expect(await screen.findByText("news.example.com")).toBeInTheDocument();
  expect(screen.getByText(/Live SES verification and account quota require/)).toBeInTheDocument();
  expect(live).not.toHaveBeenCalled();
  expect(screen.queryByText("Created at provisioning")).not.toBeInTheDocument();
});

test("magic-link Settings displays the deployed org-scoped JWKS route", async () => {
  meta();
  render(<Settings org="acme" grant={{ role: "analyst", orgs: ["acme"] }} />);
  await userEvent.setup().click(screen.getByRole("tab", { name: "Magic-link & entitlement" }));
  expect(await screen.findByText("/orgs/acme/.well-known/jwks.json")).toBeInTheDocument();
});

test("first customer-sync save keeps the safe blank-secret path available", async () => {
  meta();
  vi.spyOn(api, "sendingIdentity").mockResolvedValue({ orgId: "acme", domains: [], account: {} } as never);
  vi.spyOn(api, "customerSync").mockResolvedValue({ configured: false } as never);
  const save = vi.spyOn(api, "saveCustomerSync").mockResolvedValue({
    configured: true, endpoint: "https://customers.example.test/events", tableName: "customers", enabled: true,
  } as never);
  const user = userEvent.setup();
  render(<Settings org="acme" grant={{ role: "developer_admin", orgs: "*" }} />);
  await user.click(screen.getByRole("tab", { name: "Customer sync" }));
  await user.type(await screen.findByLabelText("HTTPS endpoint"), "https://customers.example.test/events");
  await user.type(screen.getByLabelText("External table name"), "customers");
  await user.type(screen.getByLabelText("Endpoint secret"), "initial-secret");
  await user.click(screen.getByRole("button", { name: "Save customer sync" }));

  expect(await screen.findByText(/Customer sync saved/)).toBeInTheDocument();
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/leave blank only to keep the existing secret/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Endpoint secret/)).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save customer sync" })).not.toBeDisabled();
});

test("advanced settings card allows managing hourlyRecurring flag", async () => {
  meta();
  const saveSettingsSpy = vi.spyOn(api, "saveSettings").mockResolvedValue({ hourlyEnabled: true });
  const user = userEvent.setup();
  render(<Settings org="acme" grant={{ role: "developer_admin", orgs: "*" }} />);

  // Should load the advanced features card on Domains tab
  const checkbox = await screen.findByLabelText(/Enable Hourly Recurring/i);
  expect(checkbox).not.toBeChecked();

  await user.click(checkbox);
  expect(checkbox).toBeChecked();

  const saveBtn = screen.getByRole("button", { name: "Save settings" });
  await user.click(saveBtn);

  expect(await screen.findByText(/Settings saved successfully/i)).toBeInTheDocument();
  expect(saveSettingsSpy).toHaveBeenCalledWith("acme", { hourlyEnabled: true });
});
