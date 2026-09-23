/**
 * Settings → Organization (#294).
 *
 * The behaviour worth pinning at the UI is the never-delete promise. An
 * operator reading "change the sending domain" would reasonably assume the old
 * one is removed — and in a shared AWS account it may still be carrying mail
 * this deployment knows nothing about. The copy has to say so, and the DNS the
 * new domain needs has to be shown, because addressium does not write DNS.
 */
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./screens/Settings.js";
import { api } from "./api.js";
import type { Grant } from "./rbac.js";

const GRANT: Grant = { role: "developer_admin", orgs: "*" };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stubOrg() {
  vi.spyOn(api, "orgMeta").mockResolvedValue({
    orgId: "acme", name: "Acme News", environment: "dev", setupComplete: true,
    primaryDomain: "old.example.com", defaultTimezone: "UTC", domains: ["old.example.com"],
  } as never);
}

test("the domain field says existing identities are kept, not replaced", async () => {
  stubOrg();
  render(<Settings org="acme" grant={GRANT} />);

  const label = await screen.findByText(/Add a sending domain/i);
  expect(label).toBeInTheDocument();
  // "Add", and an explicit promise about the old one — an operator must not
  // read this as a replacement.
  expect(screen.getByText(/Existing domains are KEPT/i)).toBeInTheDocument();
});

test("a domain change renders the DNS records the operator must publish", async () => {
  stubOrg();
  const update = vi.spyOn(api, "updateOrganization").mockResolvedValue({
    orgId: "acme",
    changed: [{ field: "primaryDomain", from: "old.example.com", to: "new.example.com" }],
    dns: [
      { type: "CNAME", name: "tok1._domainkey.new.example.com", value: "tok1.dkim.amazonses.com", note: "DKIM." },
      { type: "TXT", name: "new.example.com", value: "v=spf1 include:amazonses.com ~all" },
    ],
    warning: "2 list(s) still send from old.example.com: ledger, weekly.",
  } as never);

  const user = userEvent.setup();
  render(<Settings org="acme" grant={GRANT} />);
  await screen.findByText(/Add a sending domain/i);

  await user.type(screen.getByPlaceholderText("news.example.com"), "new.example.com");
  await user.click(screen.getByRole("button", { name: /Save organization/i }));

  await waitFor(() => expect(update).toHaveBeenCalled());
  expect(update.mock.calls[0]![1]).toMatchObject({ addDomain: "new.example.com" });

  // The records, because the domain cannot send until they resolve and
  // addressium deliberately does not write DNS (it is in Cloudflare).
  expect(await screen.findByText("tok1._domainkey.new.example.com")).toBeInTheDocument();
  expect(screen.getByText("v=spf1 include:amazonses.com ~all")).toBeInTheDocument();
  // And the lists left behind on the previous domain.
  expect(screen.getByText(/still send from old\.example\.com/i)).toBeInTheDocument();
});
