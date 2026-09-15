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
