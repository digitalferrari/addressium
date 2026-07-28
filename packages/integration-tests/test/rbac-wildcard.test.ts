/**
 * Regression (#168): "*" is a wildcard ONLY as the entire `custom:orgs` claim.
 *
 * A list containing it ("orgA,*") previously parsed to ["orgA","*"], and the
 * Cedar policy tested `principal.orgs.contains("*")` against that set — granting
 * every tenant, while `inScope()` denied. The two authorization paths disagreed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CedarAuthorizer, ForbiddenError, authorize, grantFromClaims, inScope } from "@addressium/rbac";

test("a smuggled `*` inside the org list is rejected outright", () => {
  for (const claim of ["orgA,*", "*,orgA", "orgA, * ", "orgA,orgB,*"]) {
    assert.throws(
      () => grantFromClaims({ "custom:role": "editor", "custom:orgs": claim }),
      ForbiddenError,
      `claim ${JSON.stringify(claim)} must not parse`,
    );
  }
});

test("a bare `*` still means all orgs", () => {
  const g = grantFromClaims({ "custom:role": "developer_admin", "custom:orgs": "*" });
  assert.equal(g.orgs, "*");
  assert.equal(inScope(g, "anything"), true);
  assert.doesNotThrow(() => authorize(g, "campaigns:manage", "anything"));
});

test("Cedar and inScope agree, and neither is fooled by a literal `*` org id", () => {
  const cedar = new CedarAuthorizer();
  // Construct the dangerous grant directly, bypassing grantFromClaims, to prove
  // the policy itself no longer treats "*" as a wildcard inside the set.
  const smuggled = { role: "editor" as const, orgs: ["orgA", "*"] };
  assert.equal(cedar.isAllowed(smuggled, "campaigns:manage", "orgVICTIM"), false);
  assert.equal(inScope(smuggled, "orgVICTIM"), false);
  // ...and still allows its legitimately scoped org.
  assert.equal(cedar.isAllowed(smuggled, "campaigns:manage", "orgA"), true);
  assert.equal(inScope(smuggled, "orgA"), true);

  const all = { role: "developer_admin" as const, orgs: "*" as const };
  assert.equal(cedar.isAllowed(all, "identity:manage", "orgVICTIM"), true);
});
