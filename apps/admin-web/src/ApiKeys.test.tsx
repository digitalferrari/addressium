/**
 * The API keys screen (#280).
 *
 * What is asserted here is not "the table renders". It is the three claims the
 * screen makes that would be lies if the wiring drifted:
 *
 *  1. The plaintext key appears EXACTLY ONCE, from the create response, and no
 *     later read can bring it back. A refetch that repopulated it would mean the
 *     server was returning a secret it promises not to.
 *  2. "Last used" renders the real field or the literal word "Never". Never a
 *     plausible-looking timestamp — the failure this console has shipped before.
 *  3. Scope, revocation and the capability gate come from the server's response
 *     and the caller's grant, not from anything the component decided.
 */
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiKeys } from "./screens/ApiKeys.js";
import { api, type ApiKeyEntry } from "./api.js";
import type { Grant } from "./rbac.js";

const ADMIN: Grant = { role: "developer_admin", orgs: ["acme"] };
const ANALYST: Grant = { role: "analyst", orgs: ["acme"] };

const KEY: ApiKeyEntry = {
  orgId: "acme",
  keyId: "billing-sync",
  name: "Billing entitlement sync",
  scopes: ["entitlement:write"],
  displayPrefix: "ak_7Fh2Qa",
  createdAt: "2026-01-01T00:00:00.000Z",
  revoked: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a key that has never been presented reads Never, not a timestamp", async () => {
  vi.spyOn(api, "apiKeys").mockResolvedValue([KEY]);
  render(<ApiKeys org="acme" grant={ADMIN} />);
  const row = await screen.findByRole("row", { name: /Billing entitlement sync/ });
  expect(within(row).getByText("Never")).toBeInTheDocument();
  // And the screen says what WOULD set it, so "Never" does not read as broken.
  expect(screen.getByText(/it is what sets/i)).toHaveTextContent(/Last used/);
});

test("a real lastUsedAt is rendered, and it comes from the server", async () => {
  vi.spyOn(api, "apiKeys").mockResolvedValue([
    { ...KEY, lastUsedAt: "2026-01-02T03:04:05.000Z" },
  ]);
  render(<ApiKeys org="acme" grant={ADMIN} />);
  const row = await screen.findByRole("row", { name: /Billing entitlement sync/ });
  expect(within(row).queryByText("Never")).toBeNull();
  // Assert the rendered timestamp itself rather than `.getByText(/2026/)`.
  // That year regex matched BOTH this cell and the Created cell whenever the
  // runner's timezone put the two fixtures in the same year — and CI runs UTC,
  // where the created fixture (2026-01-01T00:00:00Z) renders as 1/1/2026, so
  // the query found two elements and threw. Locally (UTC-7) the same instant
  // rendered as 12/31/2025, the year was unique, and it passed. Both sides here
  // go through the same formatter in the same process, so the expectation is
  // timezone-independent.
  expect(row).toHaveTextContent(new Date("2026-01-02T03:04:05.000Z").toLocaleString());
});

test("the plaintext is shown once at creation and never again", async () => {
  const PLAINTEXT = "ak_7Fh2QaTESTONLYnotarealkeyvalue";
  const list = vi.spyOn(api, "apiKeys").mockResolvedValue([]);
  vi.spyOn(api, "issueApiKey").mockResolvedValue({
    key: KEY,
    plaintext: PLAINTEXT,
  });
  const user = userEvent.setup();
  render(<ApiKeys org="acme" grant={ADMIN} />);
  await screen.findByText(/No API keys have been issued/);

  // After creation the list returns the key WITHOUT any plaintext — which is
  // what the API actually does, and the point of the assertion below.
  list.mockResolvedValue([KEY]);

  await user.type(screen.getByPlaceholderText(/name \(e\.g\./), "Billing entitlement sync");
  await user.click(screen.getByLabelText(/Set free \/ paid entitlement/));
  await user.click(screen.getByRole("button", { name: "Create key" }));

  const field = await screen.findByLabelText("New API key");
  expect(field).toHaveValue(PLAINTEXT);
  expect(screen.getByText(/will not be shown again/i)).toBeInTheDocument();

  // Dismissing it is final: the value lived in component state only, and the
  // refreshed list cannot put it back.
  await user.click(screen.getByRole("button", { name: /I have stored it/ }));
  expect(screen.queryByLabelText("New API key")).toBeNull();
  const row = await screen.findByRole("row", { name: /Billing entitlement sync/ });
  expect(within(row).queryByText(PLAINTEXT)).toBeNull();
  // The Key column shows the prefix the server kept — not a mask of a full value.
  expect(within(row).getByText(/ak_7Fh2Qa…/)).toBeInTheDocument();
});

test("the key id is derived from the name but stays overridable", async () => {
  vi.spyOn(api, "apiKeys").mockResolvedValue([]);
  const issue = vi.spyOn(api, "issueApiKey").mockResolvedValue({ key: KEY, plaintext: "ak_x" });
  const user = userEvent.setup();
  render(<ApiKeys org="acme" grant={ADMIN} />);
  await screen.findByText(/No API keys have been issued/);

  await user.type(screen.getByPlaceholderText(/name \(e\.g\./), "Billing Entitlement Sync");
  expect(screen.getByLabelText("Key id")).toHaveValue("billing-entitlement-sync");
  await user.clear(screen.getByLabelText("Key id"));
  await user.type(screen.getByLabelText("Key id"), "billing-sync");
  await user.click(screen.getByLabelText(/Read subscribers/));
  await user.click(screen.getByRole("button", { name: "Create key" }));

  expect(issue).toHaveBeenCalledWith({
    orgId: "acme",
    keyId: "billing-sync",
    name: "Billing Entitlement Sync",
    scopes: ["subscribers:read"],
  });
});

test("a key with no scope cannot be created", async () => {
  vi.spyOn(api, "apiKeys").mockResolvedValue([]);
  const issue = vi.spyOn(api, "issueApiKey");
  const user = userEvent.setup();
  render(<ApiKeys org="acme" grant={ADMIN} />);
  await screen.findByText(/No API keys have been issued/);
  await user.type(screen.getByPlaceholderText(/name \(e\.g\./), "Nameless");
  expect(screen.getByRole("button", { name: "Create key" })).toBeDisabled();
  expect(issue).not.toHaveBeenCalled();
});

test("a revoked key keeps its row, labeled, with no Revoke button", async () => {
  vi.spyOn(api, "apiKeys").mockResolvedValue([
    { ...KEY, revoked: true, revokedAt: "2026-01-03T00:00:00.000Z" },
  ]);
  render(<ApiKeys org="acme" grant={ADMIN} />);
  const row = await screen.findByRole("row", { name: /Billing entitlement sync/ });
  expect(within(row).getByText(/revoked/)).toBeInTheDocument();
  expect(within(row).queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(screen.getByText(/kept so you can still see what each key could do/)).toBeInTheDocument();
});

test("a revoked row with no revokedAt says 'revoked' and invents no date", async () => {
  // The server derives `revoked` from `revokedAt`, so this pair cannot occur
  // today. It is asserted anyway because the tempting fallback — showing
  // `createdAt` instead — would print a real timestamp under the word
  // "revoked", which is a wrong answer rather than a missing one.
  vi.spyOn(api, "apiKeys").mockResolvedValue([{ ...KEY, revoked: true }]);
  render(<ApiKeys org="acme" grant={ADMIN} />);
  const row = await screen.findByRole("row", { name: /Billing entitlement sync/ });
  // The pill carries the bare word and nothing that could be read as a date.
  // (The Created column legitimately shows one — it has a real `createdAt`.)
  const pill = within(row).getByText(/revoked/);
  expect(pill.textContent?.trim()).toBe("revoked");
  expect(pill.textContent).not.toMatch(/ago|in \d|2025|2026/);
});

test("revoking asks first and calls the API with the key id", async () => {
  vi.spyOn(api, "apiKeys").mockResolvedValue([KEY]);
  const revokeCall = vi.spyOn(api, "revokeApiKey").mockResolvedValue({ ...KEY, revoked: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const user = userEvent.setup();
  render(<ApiKeys org="acme" grant={ADMIN} />);
  const row = await screen.findByRole("row", { name: /Billing entitlement sync/ });
  await user.click(within(row).getByRole("button", { name: "Revoke" }));
  expect(revokeCall).toHaveBeenCalledWith("acme", "billing-sync");
});

test("a failed check reports one sentence, without guessing why", async () => {
  vi.spyOn(api, "apiKeys").mockResolvedValue([KEY]);
  vi.spyOn(api, "verifyApiKey").mockRejectedValue(new Error("POST /api-keys/verify → 400"));
  const user = userEvent.setup();
  render(<ApiKeys org="acme" grant={ADMIN} />);
  await screen.findByRole("row", { name: /Billing entitlement sync/ });
  await user.type(screen.getByLabelText("API key to check"), "ak_whatever");
  await user.click(screen.getByRole("button", { name: "Check" }));
  // Deliberately does not distinguish unknown from revoked — the server does not.
  expect(await screen.findByText(/unknown, revoked, or from another org/)).toBeInTheDocument();
});

test("a role without apikeys:manage gets an explanation, not an empty table", async () => {
  const list = vi.spyOn(api, "apiKeys");
  render(<ApiKeys org="acme" grant={ANALYST} />);
  expect(await screen.findByText(/requires the/)).toHaveTextContent("apikeys:manage");
  expect(screen.queryByRole("button", { name: "Create key" })).toBeNull();
  // The console does not even ask — server-side RBAC would refuse it anyway.
  expect(list).not.toHaveBeenCalled();
});
