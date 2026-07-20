/**
 * Cedar policy engine (#30): the generated policy set enforces the role matrix
 * and org scope through the real @cedar-policy/cedar-wasm engine — same
 * decisions as the ROLES matrix, now evaluated as Cedar policies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CedarAuthorizer, buildPolicySet, grantFromClaims } from "@addressium/rbac";

test("buildPolicySet emits one Cedar permit per capability", () => {
  const text = buildPolicySet();
  assert.match(text, /permit\(principal, action == Action::"reports:view", resource\)/);
  assert.match(text, /permit\(principal, action == Action::"newsletters:close", resource\)/);
  // org-scope condition present on every permit
  assert.match(text, /principal\.orgs\.contains\("\*"\) \|\| principal\.orgs\.contains\(resource\.orgId\)/);
});

test("Cedar decisions match the role matrix + org scope", () => {
  const cedar = new CedarAuthorizer();
  const editorSummit = grantFromClaims({ "custom:role": "editor", "custom:orgs": "summit" });
  const analystStar = grantFromClaims({ "custom:role": "analyst", "custom:orgs": "*" });
  const admin = grantFromClaims({ "custom:role": "developer_admin", "custom:orgs": "summit" });

  // editor may manage campaigns in its org, but not another org, nor destructive caps
  assert.equal(cedar.isAllowed(editorSummit, "campaigns:manage", "summit"), true);
  assert.equal(cedar.isAllowed(editorSummit, "campaigns:manage", "vail"), false);
  assert.equal(cedar.isAllowed(editorSummit, "subscribers:delete", "summit"), false);
  assert.equal(cedar.isAllowed(editorSummit, "newsletters:close", "summit"), false);

  // analyst scoped to all orgs is read-only everywhere
  assert.equal(cedar.isAllowed(analystStar, "reports:view", "anything"), true);
  assert.equal(cedar.isAllowed(analystStar, "campaigns:manage", "anything"), false);

  // admin holds identity:manage in its scoped org
  assert.equal(cedar.isAllowed(admin, "identity:manage", "summit"), true);
  assert.equal(cedar.isAllowed(admin, "identity:manage", "vail"), false);
});
