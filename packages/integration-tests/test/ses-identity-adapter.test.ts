/**
 * The SESv2 → domain translation for the sending-identity readout (#285,
 * ISSUES.md #259).
 *
 * `readSendingIdentity` is tested against a fake port and `SendingIdentity.tsx`
 * against a mocked client — but both of those fakes hand over an ALREADY-CORRECT
 * `DomainIdentityStatus`. The one place SES's wire shape actually gets
 * translated is `SesIdentityStatusReader`, and nothing else exercises it.
 *
 * That matters more here than translation tests usually do, because of the
 * direction this layer fails in. If `VerifiedForSendingStatus` is ever
 * misspelled, moved, or dropped by an SDK bump, the reader passes `undefined`
 * into `stateFrom`, the switch falls through to its default, and EVERY domain —
 * verified ones included — comes back `pending`. The console then tells an
 * operator to go republish DKIM records that are already correct. That is the
 * fabricated negative the whole four-state design exists to prevent, and it
 * would pass every domain test, every component test, the build and typecheck
 * without a murmur, because none of them ever see a real SES response shape.
 *
 * So these assert the field names, in both directions: the shape SES documents
 * maps to the state we claim, and a response MISSING a field produces an absent
 * value rather than a confident zero.
 *
 * Pure in-memory fakes — no AWS, no local endpoint, no Docker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SesIdentityStatusReader } from "@addressium/adapters-aws";

/** A client whose `send` answers by command name, like provisioning-events.test.ts. */
function fakeClient(behavior: Record<string, () => unknown>) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    config: { region: "us-east-1" },
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      const b = behavior[name];
      if (b) return b();
      return {};
    },
  };
}

const reader = (behavior: Record<string, () => unknown>) => {
  const client = fakeClient(behavior);
  return { r: new SesIdentityStatusReader(client as never), client };
};

test("VerifiedForSendingStatus: true maps to verified", async () => {
  const { r, client } = reader({
    GetEmailIdentityCommand: () => ({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS", Tokens: ["t1", "t2", "t3"] },
      MailFromAttributes: {
        MailFromDomain: "bounce.news.example.com",
        MailFromDomainStatus: "SUCCESS",
      },
    }),
  });
  const got = await r.getDomain("news.example.com");
  assert.equal(got?.state, "verified");
  assert.equal(got?.domain, "news.example.com");
  // SES's own spelling, passed through rather than re-worded.
  assert.equal(got?.dkimStatus, "SUCCESS");
  assert.equal(got?.mailFromDomain, "bounce.news.example.com");
  assert.equal(got?.mailFromStatus, "SUCCESS");
  // The identity is addressed by NAME — a wrong key here would query nothing.
  assert.equal(client.calls[0]?.input.EmailIdentity, "news.example.com");
});

/**
 * The regression this file exists for. A verified identity must NOT come back
 * pending just because the DKIM sub-status is unremarkable: `verified` is read
 * off `VerifiedForSendingStatus`, and if that field name ever stops matching,
 * this is the test that says so.
 */
test("a verified identity is verified even when DKIM status is not SUCCESS", async () => {
  const { r } = reader({
    GetEmailIdentityCommand: () => ({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "PENDING" },
    }),
  });
  assert.equal((await r.getDomain("news.example.com"))?.state, "verified");
});

test("an unverified identity with DKIM FAILED maps to failed, not pending", async () => {
  const { r } = reader({
    GetEmailIdentityCommand: () => ({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "FAILED" },
    }),
  });
  const got = await r.getDomain("news.example.com");
  assert.equal(got?.state, "failed");
  assert.equal(got?.dkimStatus, "FAILED");
});

test("an unverified identity awaiting DNS maps to pending", async () => {
  const { r } = reader({
    GetEmailIdentityCommand: () => ({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "PENDING" },
    }),
  });
  assert.equal((await r.getDomain("news.example.com"))?.state, "pending");
});

/**
 * An org provisioned before the custom MAIL FROM existed (#200) has no
 * `MailFromAttributes`. That must render as "none configured", which means the
 * fields have to be ABSENT rather than empty strings the UI would print.
 */
test("a missing MAIL FROM leaves both fields absent, not empty", async () => {
  const { r } = reader({
    GetEmailIdentityCommand: () => ({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS" },
    }),
  });
  const got = await r.getDomain("news.example.com");
  assert.equal(got?.mailFromDomain, undefined);
  assert.equal(got?.mailFromStatus, undefined);
  assert.equal("mailFromDomain" in (got ?? {}), false);
});

/**
 * NotFoundException is the ONE error turned into a value: SES saying "no such
 * identity" is an answer about the world, and the domain layer renders it as
 * `not_found` — a different instruction to the operator than `pending`.
 */
test("NotFoundException becomes undefined, not a throw", async () => {
  const { r } = reader({
    GetEmailIdentityCommand: () => {
      const e = new Error("identity does not exist");
      e.name = "NotFoundException";
      throw e;
    },
  });
  assert.equal(await r.getDomain("gone.example.com"), undefined);
});

/**
 * Everything else propagates. An AccessDenied swallowed here would surface as
 * `not_found` — the console telling an operator their SES identity is missing
 * when the truth is the admin router lost its `ses:GetEmailIdentity` grant.
 */
test("any other SES error propagates so the domain layer can report it as unknown", async () => {
  const { r } = reader({
    GetEmailIdentityCommand: () => {
      const e = new Error("not authorized to perform ses:GetEmailIdentity");
      e.name = "AccessDeniedException";
      throw e;
    },
  });
  await assert.rejects(() => r.getDomain("news.example.com"), /ses:GetEmailIdentity/);
});

/** The sandbox field, by name. This is the fact the whole feature turns on. */
test("ProductionAccessEnabled: false maps to productionAccess: false", async () => {
  const { r, client } = reader({
    GetAccountCommand: () => ({
      ProductionAccessEnabled: false,
      SendingEnabled: true,
      EnforcementStatus: "HEALTHY",
      SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 3 },
    }),
  });
  const got = await r.getAccount();
  assert.equal(got.productionAccess, false);
  assert.equal(got.sendingEnabled, true);
  assert.equal(got.enforcementStatus, "HEALTHY");
  assert.equal(got.max24HourSend, 200);
  assert.equal(got.maxSendRate, 1);
  assert.equal(got.sentLast24Hours, 3);
  assert.equal(client.calls[0]?.name, "GetAccountCommand");
});

test("ProductionAccessEnabled: true maps to productionAccess: true", async () => {
  const { r } = reader({
    GetAccountCommand: () => ({
      ProductionAccessEnabled: true,
      SendingEnabled: true,
      SendQuota: { Max24HourSend: -1, MaxSendRate: 14 },
    }),
  });
  const got = await r.getAccount();
  assert.equal(got.productionAccess, true);
  // -1 is SES's "unlimited". Passed through unmangled; the UI words it.
  assert.equal(got.max24HourSend, -1);
  // Not supplied by SES, so absent — the UI prints "not reported".
  assert.equal(got.sentLast24Hours, undefined);
});

/**
 * A response with no `SendQuota` must leave the numbers ABSENT. A quota
 * defaulted to 0 is a figure an operator would plan a send around, and it would
 * be one we invented — the same class of lie as a fabricated verification.
 */
test("a response without SendQuota yields absent numbers, never zeros", async () => {
  const { r } = reader({ GetAccountCommand: () => ({ ProductionAccessEnabled: true }) });
  const got = await r.getAccount();
  assert.equal(got.max24HourSend, undefined);
  assert.equal(got.maxSendRate, undefined);
  assert.equal(got.sentLast24Hours, undefined);
  assert.equal("max24HourSend" in got, false);
  // The one thing SES did say still comes through.
  assert.equal(got.productionAccess, true);
});

/**
 * An account response missing `ProductionAccessEnabled` must not read as the
 * sandbox. "We are in the sandbox" and "SES did not tell us" send an operator
 * to two different places.
 */
test("a missing ProductionAccessEnabled is absent, not false", async () => {
  const { r } = reader({ GetAccountCommand: () => ({ SendingEnabled: true }) });
  const got = await r.getAccount();
  assert.equal(got.productionAccess, undefined);
  assert.equal("productionAccess" in got, false);
});

/**
 * The account read does NOT swallow errors — `readSendingIdentity` catches and
 * turns them into `account.reason`, which is what keeps "could not check" and
 * "in the sandbox" distinguishable.
 */
test("an account read error propagates rather than reading as the sandbox", async () => {
  const { r } = reader({
    GetAccountCommand: () => {
      const e = new Error("not authorized to perform ses:GetAccount");
      e.name = "AccessDeniedException";
      throw e;
    },
  });
  await assert.rejects(() => r.getAccount(), /ses:GetAccount/);
});
