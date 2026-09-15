/**
 * The live SES sending-identity readout (#285, ISSUES.md #259).
 *
 * The defect this feature exists to prevent is a subscriber being refused by
 * SES with no way for an operator to see why. The defect the TESTS exist to
 * prevent is the console answering that question with a value it did not
 * actually read: a missing IAM grant rendering as "not verified", or an
 * unreadable account rendering as "cannot send". Both are fabrications, and
 * both are the sort a boolean-shaped API invites — so most of what is asserted
 * below is about the difference between "no" and "could not ask".
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  readSendingIdentity,
  type AccountSendingStatus,
  type DomainIdentityStatus,
  type SesIdentityReader,
} from "@addressium/domain";

const ORG = "summit";

/** A stub reader. Anything not given is an answer the test does not care about. */
function reader(opts: {
  account?: AccountSendingStatus | (() => never);
  domains?: Record<string, DomainIdentityStatus | undefined | (() => never)>;
}): SesIdentityReader {
  return {
    async getAccount() {
      const a = opts.account ?? {};
      if (typeof a === "function") return a();
      return a;
    },
    async getDomain(domain: string) {
      const d = (opts.domains ?? {})[domain];
      if (typeof d === "function") return d();
      return d;
    },
  };
}

/** The single domain row, asserting there is exactly one. */
function only(report: { domains: DomainIdentityStatus[] }): DomainIdentityStatus {
  assert.equal(report.domains.length, 1);
  return report.domains[0]!;
}

const PRODUCTION: AccountSendingStatus = {
  productionAccess: true,
  sendingEnabled: true,
  enforcementStatus: "HEALTHY",
  max24HourSend: 50000,
  maxSendRate: 14,
  sentLast24Hours: 120,
};

const SANDBOX: AccountSendingStatus = {
  productionAccess: false,
  sendingEnabled: true,
  enforcementStatus: "HEALTHY",
  max24HourSend: 200,
  maxSendRate: 1,
  sentLast24Hours: 3,
};

const verified = (domain: string): DomainIdentityStatus => ({
  domain,
  state: "verified",
  dkimStatus: "SUCCESS",
  mailFromDomain: `bounce.${domain}`,
  mailFromStatus: "SUCCESS",
});

test("a verified domain on a production account can send", async () => {
  const report = await readSendingIdentity(
    reader({ account: PRODUCTION, domains: { "a.example.com": verified("a.example.com") } }),
    ORG,
    ["a.example.com"],
  );
  assert.equal(report.orgId, ORG);
  assert.equal(report.canSend, true);
  assert.equal(only(report).state, "verified");
  assert.equal(only(report).dkimStatus, "SUCCESS");
  assert.equal(report.account.productionAccess, true);
  assert.equal(report.account.max24HourSend, 50000);
  // Nothing degraded, so nothing explains a degradation.
  assert.equal(report.account.reason, undefined);
  assert.equal(only(report).reason, undefined);
});

/**
 * The failure that produced the public incident: everything about the DOMAIN is
 * fine, and mail to a stranger is still refused. The report must say so, and it
 * must say so through the account half — an operator staring at a green DKIM
 * row is exactly the person who needs `productionAccess: false` named.
 */
test("a verified domain on a SANDBOX account cannot send", async () => {
  const report = await readSendingIdentity(
    reader({ account: SANDBOX, domains: { "a.example.com": verified("a.example.com") } }),
    ORG,
    ["a.example.com"],
  );
  assert.equal(report.canSend, false);
  assert.equal(report.account.productionAccess, false);
  assert.equal(only(report).state, "verified");
});

test("a pending domain is pending, not failed", async () => {
  const report = await readSendingIdentity(
    reader({
      account: PRODUCTION,
      domains: {
        "a.example.com": { domain: "a.example.com", state: "pending", dkimStatus: "PENDING" },
      },
    }),
    ORG,
    ["a.example.com"],
  );
  assert.equal(only(report).state, "pending");
  // No verified domain and nothing unknown: a definite no.
  assert.equal(report.canSend, false);
});

/**
 * A domain on the org record that SES has never heard of. Distinct from
 * `pending` (SES knows it and is waiting on DNS) and from `unknown` (we could
 * not ask): this is provisioning having half-run, and it needs its own word or
 * an operator will go publish DNS records for an identity that does not exist.
 */
test("a domain SES does not know is not_found, not pending", async () => {
  const report = await readSendingIdentity(
    reader({ account: PRODUCTION, domains: { "gone.example.com": undefined } }),
    ORG,
    ["gone.example.com"],
  );
  assert.equal(only(report).state, "not_found");
  assert.equal(only(report).reason, undefined);
});

/**
 * The IAM regression test. If the `ses:GetEmailIdentity` grant is ever dropped
 * from the admin router, this is the shape the console must get: `unknown` with
 * the AccessDenied message attached — NEVER `pending` or `failed`, which would
 * tell an operator their DNS is wrong when their IAM policy is.
 */
test("a domain read that throws is unknown WITH a reason, never a negative verdict", async () => {
  const boom = () => {
    throw new Error("AccessDeniedException: not authorized to perform ses:GetEmailIdentity");
  };
  const report = await readSendingIdentity(
    reader({ account: PRODUCTION, domains: { "a.example.com": boom } }),
    ORG,
    ["a.example.com"],
  );
  assert.equal(only(report).state, "unknown");
  assert.match(only(report).reason ?? "", /ses:GetEmailIdentity/);
  assert.notEqual(only(report).state, "pending");
  // No verified domain, but the one domain might BE verified — so undefined.
  assert.equal(report.canSend, undefined);
});

/**
 * Same regression, account half. An unreadable account must not read as the
 * sandbox: "we are in the sandbox" and "we cannot tell whether we are in the
 * sandbox" send an operator to two different places.
 */
test("an account read that throws leaves productionAccess unknown, not false", async () => {
  const report = await readSendingIdentity(
    reader({
      account: () => {
        throw new Error("AccessDeniedException: not authorized to perform ses:GetAccount");
      },
      domains: { "a.example.com": verified("a.example.com") },
    }),
    ORG,
    ["a.example.com"],
  );
  assert.equal(report.account.productionAccess, undefined);
  assert.match(report.account.reason ?? "", /ses:GetAccount/);
  // Quota fields stay ABSENT rather than zero: an unreadable quota and a quota
  // of zero are different facts, and only one of them is true.
  assert.equal(report.account.max24HourSend, undefined);
  assert.equal(report.account.sentLast24Hours, undefined);
  // The domain still read fine, so that half of the report survives.
  assert.equal(only(report).state, "verified");
  assert.equal(report.canSend, undefined);
});

/** One failing domain must not blank the others. */
test("domains degrade independently", async () => {
  const report = await readSendingIdentity(
    reader({
      account: PRODUCTION,
      domains: {
        "a.example.com": verified("a.example.com"),
        "b.example.com": () => {
          throw new Error("Throttling: rate exceeded");
        },
        "c.example.com": { domain: "c.example.com", state: "pending", dkimStatus: "PENDING" },
      },
    }),
    ORG,
    ["a.example.com", "b.example.com", "c.example.com"],
  );
  assert.deepEqual(
    report.domains.map((d) => d.state),
    ["verified", "unknown", "pending"],
  );
  // A verified domain on a production account: the unknown one changes nothing.
  assert.equal(report.canSend, true);
});

/** Every domain on the record is read, in order — not just `domains[0]`. */
test("every domain on the org record is read", async () => {
  const asked: string[] = [];
  const r: SesIdentityReader = {
    async getAccount() {
      return PRODUCTION;
    },
    async getDomain(domain: string) {
      asked.push(domain);
      return verified(domain);
    },
  };
  const report = await readSendingIdentity(r, ORG, ["a.example.com", "b.example.com"]);
  assert.deepEqual(asked, ["a.example.com", "b.example.com"]);
  assert.deepEqual(
    report.domains.map((d) => d.domain),
    ["a.example.com", "b.example.com"],
  );
});

/**
 * An org provisioned with no domain. The setup checklist's failing
 * `sending_domain` step, seen from the other side — and not an error.
 */
test("an org with no domains reports the account and an empty list", async () => {
  const report = await readSendingIdentity(reader({ account: PRODUCTION }), ORG, []);
  assert.deepEqual(report.domains, []);
  assert.equal(report.account.productionAccess, true);
  // Production access, but nothing verified to send FROM.
  assert.equal(report.canSend, false);
});

/** SES having paused the account is its own stop, separate from the sandbox. */
test("sending disabled by SES blocks sending even with production access", async () => {
  const report = await readSendingIdentity(
    reader({
      account: { ...PRODUCTION, sendingEnabled: false, enforcementStatus: "SHUTDOWN" },
      domains: { "a.example.com": verified("a.example.com") },
    }),
    ORG,
    ["a.example.com"],
  );
  assert.equal(report.canSend, false);
  assert.equal(report.account.enforcementStatus, "SHUTDOWN");
});

/**
 * A sandbox account is a definite "no" whatever the domains say — including
 * domains that could not be read. This is the one direction where an unknown
 * domain does NOT make the verdict unknown, because no domain state can rescue
 * an account that may only mail addresses it has verified.
 */
test("the sandbox verdict survives an unreadable domain", async () => {
  const report = await readSendingIdentity(
    reader({
      account: SANDBOX,
      domains: {
        "a.example.com": () => {
          throw new Error("Throttling: rate exceeded");
        },
      },
    }),
    ORG,
    ["a.example.com"],
  );
  assert.equal(report.canSend, false);
  assert.equal(only(report).state, "unknown");
});
