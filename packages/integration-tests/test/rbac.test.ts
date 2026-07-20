/**
 * RBAC: grant parsing from JWT claims + capability/org-scope enforcement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ForbiddenError, authorize, can, grantFromClaims } from "@addressium/rbac";

test("grantFromClaims parses role + org scope", () => {
  const g = grantFromClaims({ "custom:role": "editor", "custom:orgs": "summit,vail" });
  assert.equal(g.role, "editor");
  assert.deepEqual(g.orgs, ["summit", "vail"]);

  const all = grantFromClaims({ "custom:role": "developer_admin", "custom:orgs": "*" });
  assert.equal(all.orgs, "*");

  // Missing/invalid role is rejected.
  assert.throws(() => grantFromClaims({}), ForbiddenError);
  assert.throws(() => grantFromClaims({ "custom:role": "wizard" }), ForbiddenError);
});

test("capability matrix: analyst is read-only, editor can't delete/close", () => {
  assert.equal(can("analyst", "reports:view"), true);
  assert.equal(can("analyst", "campaigns:schedule"), false);
  assert.equal(can("editor", "campaigns:schedule"), true);
  assert.equal(can("editor", "subscribers:delete"), false);
  assert.equal(can("editor", "newsletters:close"), false);
  assert.equal(can("developer_admin", "identity:manage"), true);
});

test("authorize enforces capability AND org scope", () => {
  const editorNorthwind = grantFromClaims({ "custom:role": "editor", "custom:orgs": "summit" });

  // allowed: editor may schedule for its own org
  authorize(editorNorthwind, "campaigns:schedule", "summit");

  // denied: wrong org (cross-tenant)
  assert.throws(() => authorize(editorNorthwind, "campaigns:schedule", "vail"), ForbiddenError);

  // denied: capability the role lacks
  assert.throws(() => authorize(editorNorthwind, "subscribers:delete", "summit"), ForbiddenError);

  // analyst (read-only) cannot schedule even in-scope
  const analyst = grantFromClaims({ "custom:role": "analyst", "custom:orgs": "*" });
  assert.throws(() => authorize(analyst, "campaigns:schedule", "summit"), ForbiddenError);
  authorize(analyst, "reports:view", "summit"); // but can view
});
