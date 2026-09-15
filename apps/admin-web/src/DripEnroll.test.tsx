/**
 * Hand-enrolment (#255/#283) — the three claims the card makes before it fires.
 *
 * This is the one enrollment path with no double opt-in in front of it, so the
 * things worth guarding are the ones that decide whether real mail goes out to
 * the wrong person, or goes out under a description the operator did not read:
 *
 *  - only `manual` sequences can be chosen (a signup-triggered one is a 400,
 *    and offering it would only be a way to earn that error);
 *  - the consent gate says what `enrollManually` will say, before the click;
 *  - the #265 error contract reaches the operator as a sentence, not as the
 *    `POST … → 400: {"error": …}` envelope `call` throws.
 *
 * Asserted as exported functions rather than through the DOM, the way
 * `Analytics.test.tsx` tests `pctOf`/`funnelRows`: these are pure, and the DOM
 * matchers this suite would otherwise need (`toBeInTheDocument`) are not
 * registered in this workspace — six other test files fail on them today.
 */
import { expect, test } from "vitest";
import { consentGate, enrollConsequence, enrollErrorText, waitLabel } from "./screens/Drips.js";
import type { DripSequence, SubscriberDetail } from "./api.js";

const MANUAL: DripSequence = {
  orgId: "acme",
  sequenceId: "paid-onboarding",
  name: "Paid onboarding",
  trigger: { kind: "manual" },
  steps: [
    { stepId: "day1", waitSeconds: 86_400, listId: "ledger", templateId: "t", subject: "Getting started" },
    { stepId: "day3", waitSeconds: 172_800, listId: "ledger", templateId: "t", subject: "Your first week" },
  ],
};

const DETAIL: SubscriberDetail = {
  orgId: "acme",
  sub: "s1",
  email: "reader@example.com",
  status: "active",
  entitlement: "paid",
  attributes: {},
  lists: [{ listId: "ledger", name: "The Morning Ledger", status: "confirmed" }],
  segments: [],
  suppressed: false,
};

// --- the consequence, stated from the sequence the API returned ------------

test("the consequence names the step count, the first subject and WHEN — not 'now'", () => {
  // `nextWaitSeconds` is step 0's OWN wait: the machine starts at the Wait
  // (#201). "An email goes out now" would be wrong for every sequence whose
  // first step waits, which is most of them.
  expect(enrollConsequence(MANUAL, "reader@example.com")).toBe(
    "Sends 2 emails to reader@example.com, starting with “Getting started” in 1 day.",
  );
  const immediate: DripSequence = { ...MANUAL, steps: [{ ...MANUAL.steps[0]!, waitSeconds: 0 }] };
  expect(enrollConsequence(immediate, "reader@example.com")).toBe(
    "Sends 1 email to reader@example.com, starting with “Getting started” immediately.",
  );
});

test("a wait is described in a unit a human can act on, and is singularized", () => {
  expect(waitLabel(0)).toBe("immediately");
  expect(waitLabel(-5)).toBe("immediately");
  expect(waitLabel(30)).toBe("in 30s");
  expect(waitLabel(900)).toBe("in 15 minutes");
  expect(waitLabel(7_200)).toBe("in 2 hours");
  expect(waitLabel(259_200)).toBe("in 3 days");
  // One day is the most common first wait there is — the integration test's own
  // fixture uses it — and "in 1 days" on the line that precedes real sends is
  // exactly the kind of sloppiness an operator stops reading past.
  expect(waitLabel(86_400)).toBe("in 1 day");
  expect(waitLabel(3_600)).toBe("in 1 hour");
  expect(waitLabel(60)).toBe("in 1 minute");
});

test("a sequence with no steps says so instead of promising a send", () => {
  expect(enrollConsequence({ ...MANUAL, steps: [] }, "reader@example.com")).toMatch(/nothing to send/);
});

// --- the consent gate: the refusal, before the click ----------------------

test("confirmed on step 1's list is what makes the button live", () => {
  const gate = consentGate(MANUAL, DETAIL);
  expect(gate?.ok).toBe(true);
  expect(gate?.message).toMatch(/Confirmed on The Morning Ledger \(ledger\)/);
});

test("a pending subscription is refused here, in the words the server would use", () => {
  // `enrollManually` refuses anything that is not `confirmed` on step 0's list.
  // Reaching that as a red 400 after the click would be a worse way to learn it.
  const pending: SubscriberDetail = {
    ...DETAIL,
    lists: [{ listId: "ledger", name: "The Morning Ledger", status: "pending" }],
  };
  const gate = consentGate(MANUAL, pending);
  expect(gate?.ok).toBe(false);
  expect(gate?.message).toMatch(/is pending, not confirmed, on ledger/);
});

test("no subscription at all is a different sentence from the wrong status", () => {
  const gate = consentGate(MANUAL, { ...DETAIL, lists: [] });
  expect(gate?.ok).toBe(false);
  expect(gate?.message).toMatch(/has no subscription to ledger/);
  expect(gate?.message).not.toMatch(/not confirmed/);
});

test("consent that has not been read yet is undefined, never a guess at 'ok'", () => {
  // The answer comes from GET /orgs/{org}/subscribers/{sub}. Collapsing "not
  // asked" into "not confirmed" would tell the operator something false, and
  // collapsing it into `ok` would arm the button on no evidence.
  expect(consentGate(MANUAL, undefined)).toBe(undefined);
});

test("a sequence with no steps has no list to check consent against", () => {
  const gate = consentGate({ ...MANUAL, steps: [] }, DETAIL);
  expect(gate?.ok).toBe(false);
});

// --- the #265 error contract, as the operator reads it --------------------

test("a 400 reaches the operator as its sentence, not as the request envelope", () => {
  const e = new Error(
    'POST /drip-sequences/enroll → 400: {"error":"drip sequence welcome is signup-triggered, not manual"}',
  );
  expect(enrollErrorText(e)).toBe("drip sequence welcome is signup-triggered, not manual");
});

test("a 403 is named as a role problem, because retrying will not fix it", () => {
  const e = new Error('POST /drip-sequences/enroll → 403: {"error":"forbidden"}');
  expect(enrollErrorText(e)).toMatch(/campaigns:manage/);
});

test("a 500 stays the server's generic sentence — the real error is in the log", () => {
  // #265: a Step Functions IAM denial is our infrastructure, not the operator's
  // request. The SDK's text never reaches the caller, so there is nothing here
  // to unwrap beyond the generic message the server chose.
  const e = new Error('POST /drip-sequences/enroll → 500: {"error":"something went wrong"}');
  const text = enrollErrorText(e);
  expect(text).toMatch(/something went wrong/);
  expect(text).not.toMatch(/AccessDenied/);
});

test("a non-JSON failure is shown as-is rather than swallowed into an empty string", () => {
  const e = new Error("POST /drip-sequences/enroll → 502: <html>Bad Gateway</html>");
  expect(enrollErrorText(e)).toBe("<html>Bad Gateway</html>");
  expect(enrollErrorText("TypeError: Failed to fetch")).toBe("TypeError: Failed to fetch");
});
