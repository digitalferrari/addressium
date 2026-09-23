/**
 * Correcting an organization's settings (#294).
 *
 * The load-bearing guarantee is that a domain change ADDS and never REMOVES.
 * A domain in `domains` is a verified SES identity, and in a shared account it
 * may carry mail this deployment knows nothing about — during the Pinpoint
 * cutover the same identities serve seven publications from the legacy system.
 * Dropping one to tidy up a settings change would stop that mail with no
 * warning and no way back short of re-verification.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planOrgUpdate, listsSendingFrom, memStores, SystemClock } from "@addressium/domain";
import type { Organization } from "@addressium/core";

const ORG: Organization = {
  orgId: "acme", name: "Acme News", domains: ["old.example.com", "legacy.example.com"],
  sesConfigSet: "cs", ipMode: "shared", suppressionScope: "hybrid",
  defaultTimezone: "UTC",
} as Organization;

test("changing the sending domain KEEPS every previous identity", () => {
  const { org, changed } = planOrgUpdate(ORG, { addDomain: "new.example.com" });

  assert.equal(org.domains[0], "new.example.com", "the new domain becomes primary");
  // The whole point. Both previous identities survive.
  assert.ok(org.domains.includes("old.example.com"), "the previous domain was REMOVED");
  assert.ok(org.domains.includes("legacy.example.com"), "an older domain was REMOVED");
  assert.equal(org.domains.length, 3);
  assert.deepEqual(changed, [
    { field: "primaryDomain", from: "old.example.com", to: "new.example.com" },
  ]);
});

test("re-promoting an existing domain does not duplicate it", () => {
  const { org } = planOrgUpdate(ORG, { addDomain: "legacy.example.com" });
  assert.deepEqual(org.domains, ["legacy.example.com", "old.example.com"]);
});

test("provisioned and compliance fields cannot be touched", () => {
  // The allowlist is the design: these are either provisioned infrastructure
  // (editing the record would only make it disagree with AWS) or retroactive
  // compliance decisions. A general PATCH would have admitted all of them.
  const { org } = planOrgUpdate(ORG, {
    name: "Renamed",
    // @ts-expect-error — not part of OrgUpdate, and must be ignored if sent.
    sesConfigSet: "attacker-set", suppressionScope: "global", ipMode: "dedicated",
  });
  assert.equal(org.sesConfigSet, "cs");
  assert.equal(org.suppressionScope, "hybrid");
  assert.equal(org.ipMode, "shared");
  assert.equal(org.name, "Renamed", "the allowed field still changed");
});

test("a bad timezone is refused by name, not silently accepted", () => {
  // A wrong zone here moves every scheduled send, and "GMT+1" looks plausible.
  assert.throws(() => planOrgUpdate(ORG, { defaultTimezone: "GMT+1" }), /not an IANA time zone/);
  assert.throws(() => planOrgUpdate(ORG, { defaultTimezone: "" }), /not an IANA time zone/);
  const { org } = planOrgUpdate(ORG, { defaultTimezone: "America/New_York" });
  assert.equal(org.defaultTimezone, "America/New_York");
});

test("a malformed domain is refused", () => {
  for (const bad of ["https://news.example.com", "news.example.com/path", "notadomain", ""]) {
    assert.throws(() => planOrgUpdate(ORG, { addDomain: bad }), /is not a domain name/, bad);
  }
});

test("an empty or oversized name is refused", () => {
  assert.throws(() => planOrgUpdate(ORG, { name: "   " }), /cannot be empty/);
  assert.throws(() => planOrgUpdate(ORG, { name: "x".repeat(121) }), /120 characters/);
});

test("an unchanged value produces no change entry", () => {
  // `changed` drives the audit target, so a no-op save must not write an audit
  // entry claiming someone changed the sending domain.
  const { changed } = planOrgUpdate(ORG, {
    name: "Acme News", defaultTimezone: "UTC", addDomain: "old.example.com",
  });
  assert.deepEqual(changed, []);
});

test("lists still sending from the previous domain are found", async () => {
  const stores = memStores();
  const clock = new SystemClock();
  for (const [listId, from] of [
    ["ledger", "news@old.example.com"],
    ["weekly", "hello@old.example.com"],
    ["moved", "hello@new.example.com"],
  ]) {
    await stores.lists.put({
      orgId: "acme", listId: listId!, name: listId!, optInPolicy: "double",
      fromAddress: from!, access: "free", visibility: "open",
      complianceFooter: "f", physicalAddress: "1 Main St",
    });
  }
  void clock;

  const stale = await listsSendingFrom(stores, "acme", "old.example.com");
  assert.deepEqual(stale.sort(), ["ledger", "weekly"]);
  // Not a substring match: `old.example.com` must not catch `new.example.com`.
  assert.ok(!stale.includes("moved"));
});
