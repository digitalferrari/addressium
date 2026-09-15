/**
 * Add organization — the dev allowlist (#250).
 *
 * `recipientAllowedForDev` is deliberately fail-closed: a `dev` org with an
 * empty allowlist sends to nobody. The form offered the `prod`/`dev` selector
 * and never collected the list, and there is no org-update route — so choosing
 * `dev` produced an organization that could never deliver a message, and the
 * failure mode was silence. These tests hold the console to collecting the one
 * field that makes a dev org usable, at the only moment it can be set.
 *
 * The entry-shape cases mirror `packages/domain/test/dev-allowlist.test.ts`: the
 * client must never accept an entry the send guard cannot match.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddOrganization, isDevAllowlistEntry, parseDevAllowlist } from "./App.js";
import { api } from "./api.js";

let createOrg: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createOrg = vi.fn(async () => ({
    orgId: "acme",
    setupComplete: false,
    alreadyExisted: false,
    dns: [],
  }));
  vi.spyOn(api, "createOrg").mockImplementation(createOrg as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Fill the two fields that were already required, leaving environment on prod. */
async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Name/), "Northwind Times");
  await user.type(screen.getByLabelText(/Sending domain/), "mail.northwind.example");
}

test("a prod org does not ask for an allowlist and does not send one", async () => {
  // The guard never gates prod, so a list stored there is a rule nothing reads.
  const user = userEvent.setup();
  render(<AddOrganization />);
  await fillRequired(user);
  expect(screen.queryByLabelText(/Dev send allowlist/)).toBeNull();

  await user.click(screen.getByRole("button", { name: /Create organization/ }));
  expect(createOrg).toHaveBeenCalledTimes(1);
  expect(createOrg.mock.calls[0]![0]).not.toHaveProperty("devAllowlist");
});

test("choosing dev cannot be submitted with an empty allowlist (#250)", async () => {
  // The bug: this was submittable, and produced an org that could never send —
  // permanently, because `GET /orgs/{org}` is the only per-org verb.
  const user = userEvent.setup();
  render(<AddOrganization />);
  await fillRequired(user);
  await user.selectOptions(screen.getByLabelText(/Environment/), "dev");

  expect(screen.getByRole("button", { name: /Create organization/ })).toBeDisabled();
  expect(screen.getByText(/can never deliver a message/)).toBeInTheDocument();
  expect(createOrg).not.toHaveBeenCalled();
});

test("a dev org carries the allowlist it collected", async () => {
  const user = userEvent.setup();
  render(<AddOrganization />);
  await fillRequired(user);
  await user.selectOptions(screen.getByLabelText(/Environment/), "dev");
  await user.type(screen.getByLabelText(/Dev send allowlist/), "qa@team.example\n@team.example");

  await user.click(screen.getByRole("button", { name: /Create organization/ }));
  expect(createOrg.mock.calls[0]![0]).toMatchObject({
    environment: "dev",
    devAllowlist: ["qa@team.example", "@team.example"],
  });
});

test("an entry the send guard cannot match blocks submit rather than being stored", async () => {
  // `example.com` and `*@example.com` both read as "everyone at this domain"
  // and match NOTHING — accepting them would re-create the silent
  // undeliverability this issue is about, one layer up.
  const user = userEvent.setup();
  render(<AddOrganization />);
  await fillRequired(user);
  await user.selectOptions(screen.getByLabelText(/Environment/), "dev");
  await user.type(screen.getByLabelText(/Dev send allowlist/), "*@team.example");

  expect(screen.getByRole("button", { name: /Create organization/ })).toBeDisabled();
  expect(screen.getByText(/matches nothing/)).toBeInTheDocument();
});

test("the entry matcher accepts exactly the two forms recipientAllowedForDev reads", () => {
  for (const ok of ["qa@team.example", "QA@Team.test", "@allowed.test"]) {
    expect(isDevAllowlistEntry(ok), ok).toBe(true);
  }
  for (const bad of ["team.example", "*@team.example", "@localhost", "qa@", "qa at team.example", ""]) {
    expect(isDevAllowlistEntry(bad), bad).toBe(false);
  }
});

test("entries split on newlines or commas, and blanks are not entries", () => {
  // A trailing newline must not become an empty entry: `recipientAllowedForDev`
  // skips blanks, so one would be invisible here and silently ignored there.
  expect(parseDevAllowlist("a@x.test,\n b@x.test \n\n")).toEqual(["a@x.test", "b@x.test"]);
  expect(parseDevAllowlist("   ")).toEqual([]);
});
