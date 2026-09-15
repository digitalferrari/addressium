/**
 * The live SES sending-identity card (#285, ISSUES.md #259).
 *
 * The domain tests assert the report's SHAPE. What these assert is the thing a
 * shape cannot: that the screen never turns a failed check into a claim about
 * the operator's deliverability. Three specific lies are under test —
 *
 *   - an unreadable domain rendering as "not verified" (it is an IAM problem,
 *     and telling an operator to go edit DNS is the wrong instruction),
 *   - an unreadable account's quota rendering as 0 (a number somebody acts on),
 *   - `canSend: undefined` rendering as "cannot send" (an IAM gap reported as a
 *     deliverability failure).
 *
 * Plus the one this feature actually exists for: a verified domain on a SANDBOX
 * account must read as "cannot send", because that is the state that let a
 * subscriber's valid address be refused on a public page while the console
 * showed a green checklist.
 */
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SendingIdentity } from "./screens/SendingIdentity.js";
import { api, type SendingIdentityReport } from "./api.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(report: SendingIdentityReport | Error) {
  vi.spyOn(api, "sendingIdentity").mockImplementation(
    report instanceof Error
      ? () => Promise.reject(report)
      : () => Promise.resolve(report) as never,
  );
  render(<SendingIdentity org="acme" />);
}

const PRODUCTION = {
  productionAccess: true,
  sendingEnabled: true,
  enforcementStatus: "HEALTHY",
  max24HourSend: 50000,
  maxSendRate: 14,
  sentLast24Hours: 120,
};

const VERIFIED = {
  domain: "news.example.com",
  state: "verified" as const,
  dkimStatus: "SUCCESS",
  mailFromDomain: "bounce.news.example.com",
  mailFromStatus: "SUCCESS",
};

test("a verified domain on a production account reads as able to send", async () => {
  mount({ orgId: "acme", account: PRODUCTION, domains: [VERIFIED], canSend: true });
  expect(await screen.findByText("Can send")).toBeInTheDocument();
  expect(screen.getByText("Out of the sandbox")).toBeInTheDocument();
  expect(screen.getByText("Verified")).toBeInTheDocument();
  expect(screen.getByText("news.example.com")).toBeInTheDocument();
  expect(screen.getByText("50,000")).toBeInTheDocument();
});

/**
 * The incident, on screen. Everything about the domain is green and mail to a
 * stranger is still refused — so the headline must say so, and the sandbox must
 * be named as the cause rather than left for the operator to infer.
 */
test("a verified domain on a SANDBOX account reads as cannot send, and names the sandbox", async () => {
  mount({
    orgId: "acme",
    account: { ...PRODUCTION, productionAccess: false },
    domains: [VERIFIED],
    canSend: false,
  });
  expect(await screen.findByText("Cannot send to arbitrary recipients")).toBeInTheDocument();
  expect(screen.getByText("In the SES sandbox")).toBeInTheDocument();
  expect(screen.getByText(/only mail addresses it has itself verified/)).toBeInTheDocument();
  // The domain half is still true and still shown — the problem is not the DNS.
  expect(screen.getByText("Verified")).toBeInTheDocument();
});

/**
 * The IAM regression, on screen. A domain that could not be READ must not be
 * rendered with any of the words that describe a domain that failed to verify.
 */
test("an unreadable domain reads as 'could not check', never as pending or failed", async () => {
  mount({
    orgId: "acme",
    account: PRODUCTION,
    domains: [
      {
        domain: "news.example.com",
        state: "unknown",
        reason: "AccessDeniedException: not authorized to perform ses:GetEmailIdentity",
      },
    ],
    canSend: undefined,
  });
  expect(await screen.findByText("Could not check")).toBeInTheDocument();
  expect(screen.getByText(/ses:GetEmailIdentity/)).toBeInTheDocument();
  expect(screen.queryByText(/Pending — publish DKIM/)).not.toBeInTheDocument();
  expect(screen.queryByText("Verification failed")).not.toBeInTheDocument();
});

/** `canSend: undefined` is its own headline, not the negative one. */
test("an incomplete check never reads as 'cannot send'", async () => {
  mount({
    orgId: "acme",
    account: PRODUCTION,
    domains: [{ domain: "news.example.com", state: "unknown", reason: "Throttling" }],
    canSend: undefined,
  });
  expect(await screen.findByText("Could not determine")).toBeInTheDocument();
  expect(screen.queryByText("Cannot send to arbitrary recipients")).not.toBeInTheDocument();
  expect(screen.queryByText("Can send")).not.toBeInTheDocument();
});

/**
 * An account read that failed shows WHY and shows no numbers. A quota rendered
 * as 0 is a figure an operator would plan a send around, and it would be one we
 * invented.
 */
test("an unreadable account shows the reason and no fabricated quota", async () => {
  mount({
    orgId: "acme",
    account: { reason: "AccessDeniedException: not authorized to perform ses:GetAccount" },
    domains: [VERIFIED],
    canSend: undefined,
  });
  expect(await screen.findByText(/ses:GetAccount/)).toBeInTheDocument();
  expect(screen.queryByText("0")).not.toBeInTheDocument();
  expect(screen.queryByText("In the SES sandbox")).not.toBeInTheDocument();
  expect(screen.queryByText("Out of the sandbox")).not.toBeInTheDocument();
  // The domain half read fine, so it is still rendered.
  expect(screen.getByText("Verified")).toBeInTheDocument();
});

/** A domain SES has never heard of is its own finding — publishing DNS won't fix it. */
test("a domain with no SES identity says so, and says DNS will not help", async () => {
  mount({
    orgId: "acme",
    account: PRODUCTION,
    domains: [{ domain: "gone.example.com", state: "not_found" }],
    canSend: false,
  });
  expect(await screen.findByText("No SES identity")).toBeInTheDocument();
  expect(screen.getByText(/Publishing DNS will not help/)).toBeInTheDocument();
});

/** SES reports -1 for an unlimited quota; "-1" on screen would read as an error. */
test("an unlimited quota renders as 'unlimited', not -1", async () => {
  mount({
    orgId: "acme",
    account: { ...PRODUCTION, max24HourSend: -1 },
    domains: [VERIFIED],
    canSend: true,
  });
  expect(await screen.findByText("unlimited")).toBeInTheDocument();
  expect(screen.queryByText("-1")).not.toBeInTheDocument();
});

/**
 * A 403 is the server's RBAC working, not a broken check. The Setup screen is
 * `reports:view`; this route is `identity:manage`, so an analyst reaching the
 * card is a normal outcome and must not see a raw status line.
 */
test("a 403 explains the capability instead of showing a raw error", async () => {
  mount(new Error("GET /orgs/acme/sending-identity → 403: forbidden"));
  expect(await screen.findByText(/Not visible to your role/)).toBeInTheDocument();
  expect(screen.getByText("identity:manage")).toBeInTheDocument();
  expect(screen.queryByText(/403: forbidden/)).not.toBeInTheDocument();
});

/** Any other failure says the console could not ask — and claims nothing else. */
test("an unreachable route claims nothing about the domains", async () => {
  mount(new Error("GET /orgs/acme/sending-identity → 500: boom"));
  expect(await screen.findByText(/says nothing about whether the/)).toBeInTheDocument();
  expect(screen.queryByText("Cannot send to arbitrary recipients")).not.toBeInTheDocument();
});

/** An org with no domain is the failing checklist step, not an error. */
test("an org with no sending domain says there is nothing to check yet", async () => {
  mount({ orgId: "acme", account: PRODUCTION, domains: [], canSend: false });
  expect(await screen.findByText(/Nothing to check in SES yet/)).toBeInTheDocument();
});

/**
 * DMARC has no source behind it — SES reports DKIM and MAIL FROM, never the
 * `_dmarc` TXT record — so the card must SAY that rather than draw the column
 * the prototype draws. The assertion is on the absence of a table header, not
 * on the absence of the string: the prose deliberately mentions `p=none` while
 * telling the operator to go look it up themselves, which is the honest form.
 */
test("DMARC is named as unavailable rather than rendered as a column", async () => {
  mount({ orgId: "acme", account: PRODUCTION, domains: [VERIFIED], canSend: true });
  expect(await screen.findByText(/DMARC is not shown, and cannot be from here/)).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: /DMARC/i })).not.toBeInTheDocument();
  // The SPF-alignment column IS present — SES does report MAIL FROM — so the
  // absence above is a deliberate omission, not an empty table.
  expect(screen.getByRole("columnheader", { name: /SPF alignment/i })).toBeInTheDocument();
});
