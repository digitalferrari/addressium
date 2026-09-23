/**
 * Persona fixtures, driven through the real Cedar-backed authorizer.
 *
 * These assert the boundary (packages/rbac `authorize`), not the console's
 * mirror — admin-web declares its own copy of the matrix and its suite is
 * mocked, so an assertion made there proves nothing about what the API permits.
 * Drift between the two copies is covered separately (rbac-client-drift.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ForbiddenError, authorize, grantFromClaims } from "@addressium/rbac";
import { recipientAllowedForDev } from "@addressium/domain";
import {
  EMPTY_ORGS,
  MUTATIONS,
  ORG_A,
  ORG_B,
  PERSONAS,
  endUserPersonas,
  orgRecordFor,
  staffPersonas,
} from "./personas.js";

test("every staff persona's claims parse into the grant the fixture describes", () => {
  for (const p of staffPersonas()) {
    const grant = grantFromClaims({ ...p.claims });
    assert.equal(grant.role, p.claims["custom:role"], `${p.id}: role`);
    assert.deepEqual(grant.orgs, p.orgs, `${p.id}: org scope`);
  }
});

test("each staff persona holds exactly its allowed capabilities in its own org", () => {
  for (const p of staffPersonas()) {
    const grant = grantFromClaims({ ...p.claims });
    const org = p.orgs === "*" ? ORG_A : p.orgs[0]!;

    for (const cap of p.allowed) {
      assert.doesNotThrow(
        () => authorize(grant, cap, org),
        `${p.id} should hold ${cap} in ${org}`,
      );
    }
    for (const cap of p.denied) {
      assert.throws(
        () => authorize(grant, cap, org),
        ForbiddenError,
        `${p.id} must NOT hold ${cap} in ${org}`,
      );
    }
  }
});

test("org-scoped personas are denied in an org they are not scoped to", () => {
  // The interesting one is org-admin: every capability, still no cross-tenant
  // reach. If `allOrgs` ever stopped gating, only this assertion would notice.
  for (const p of staffPersonas()) {
    if (p.orgs === "*") continue;
    if (p.orgs.includes(ORG_B)) continue; // brand-editor legitimately spans both

    const grant = grantFromClaims({ ...p.claims });
    for (const cap of p.allowed) {
      assert.throws(
        () => authorize(grant, cap, ORG_B),
        ForbiddenError,
        `${p.id} must not reach ${ORG_B} with ${cap}`,
      );
    }
  }
});

test("wildcard-scoped personas reach any org, still bounded by capability", () => {
  for (const p of staffPersonas()) {
    if (p.orgs !== "*") continue;
    const grant = grantFromClaims({ ...p.claims });
    for (const cap of p.allowed) {
      assert.doesNotThrow(() => authorize(grant, cap, ORG_B), `${p.id}: ${cap} in ${ORG_B}`);
    }
    for (const cap of p.denied) {
      assert.throws(() => authorize(grant, cap, ORG_B), ForbiddenError, `${p.id}: ${cap}`);
    }
  }
});

test("the brand editor spans both orgs and no third one", () => {
  const p = PERSONAS.find((x) => x.id === "brand-editor")!;
  const grant = grantFromClaims({ ...p.claims! });
  authorize(grant, "branding:manage", ORG_A);
  authorize(grant, "branding:manage", ORG_B);
  assert.throws(() => authorize(grant, "branding:manage", "aspen"), ForbiddenError);
});

test("support may manage subscribers but never delete them", () => {
  // Spelled out rather than left to the matrix loop: this single gap is the
  // whole reason the support role is distinct from editor.
  const p = PERSONAS.find((x) => x.id === "support-agent")!;
  const grant = grantFromClaims({ ...p.claims! });
  authorize(grant, "subscribers:manage", ORG_A);
  assert.throws(() => authorize(grant, "subscribers:delete", ORG_A), ForbiddenError);
});

test("the sales rep can read reports and change nothing", () => {
  const p = PERSONAS.find((x) => x.id === "sales-rep")!;
  const grant = grantFromClaims({ ...p.claims! });
  authorize(grant, "reports:view", ORG_A);
  for (const cap of ["campaigns:schedule", "campaigns:manage", "subscribers:manage"] as const) {
    assert.throws(() => authorize(grant, cap, ORG_A), ForbiddenError, `sales rep: ${cap}`);
  }
});

test("credential mutations are rejected for every staff persona", () => {
  for (const p of staffPersonas()) {
    for (const m of MUTATIONS) {
      assert.throws(
        () => grantFromClaims(m.mutate(p.claims)),
        ForbiddenError,
        `${p.id} + ${m.id}: ${m.why}`,
      );
    }
  }
});

test("an empty org claim parses but authorizes nothing", () => {
  // Deny by default, enforced at the boundary rather than at parse time: even
  // developer_admin with no orgs reaches nothing.
  for (const p of staffPersonas()) {
    const grant = grantFromClaims(EMPTY_ORGS(p.claims));
    assert.deepEqual(grant.orgs, [], `${p.id}: empty scope should parse to no orgs`);
    for (const cap of p.allowed) {
      assert.throws(
        () => authorize(grant, cap, ORG_A),
        ForbiddenError,
        `${p.id} with no orgs must not hold ${cap}`,
      );
    }
  }
});

test("end-user personas carry no admin claims at all", () => {
  const nonStaff = endUserPersonas();
  assert.ok(nonStaff.length >= 3, "expected prospect, subscriber and departing subscriber");
  for (const p of nonStaff) {
    // Not "a role with fewer capabilities" — no admin credential exists to parse.
    assert.equal(p.claims, null, `${p.id} must not hold an admin token`);
    assert.equal(p.allowed.length, 0, `${p.id} must hold no admin capability`);
  }
});

test("persona ids are unique and fixture addresses are non-deliverable", () => {
  const ids = PERSONAS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate persona id");
  for (const p of PERSONAS) {
    // This stack sends real mail; a fixture must never name a live address.
    assert.match(p.email, /@example\.com$/, `${p.id}: ${p.email} is not a reserved domain`);
  }
});

/**
 * Send-path expectations tied to the persona's org type (§4.11).
 *
 * `orgType` was previously declarative — ../PERSONAS.md claimed it kept "a test
 * blast could not reach a live list" an assertion, while nothing read the field.
 * These drive the real guard (`recipientAllowedForDev` in @addressium/domain).
 */
test("a dev-org persona cannot reach an address off the allowlist", () => {
  const stranger = "someone.real@example.com";
  for (const p of staffPersonas()) {
    if (p.orgType !== "dev") continue;
    // Fail-closed: a dev org with no allowlist reaches no one at all.
    assert.equal(
      recipientAllowedForDev(orgRecordFor("dev"), stranger),
      false,
      `${p.id}: a dev org with an empty allowlist must send to no one`,
    );
    // Even with an allowlist, only listed addresses get through.
    const org = orgRecordFor("dev", [p.email]);
    assert.equal(recipientAllowedForDev(org, p.email), true, `${p.id}: own address allowed`);
    assert.equal(
      recipientAllowedForDev(org, stranger),
      false,
      `${p.id}: ${stranger} is off the allowlist and must be refused`,
    );
  }
});

test("a live-org persona is not gated by the dev allowlist", () => {
  for (const p of staffPersonas()) {
    if (p.orgType !== "live") continue;
    assert.equal(
      recipientAllowedForDev(orgRecordFor("live"), "anyone@example.com"),
      true,
      `${p.id}: a prod org must not be allowlist-gated`,
    );
  }
});

test("the dev allowlist matches domain suffixes case-insensitively", () => {
  const org = orgRecordFor("dev", ["@example.com"]);
  assert.equal(recipientAllowedForDev(org, "Mixed.Case@Example.COM"), true);
  assert.equal(recipientAllowedForDev(org, "nope@other.test"), false);
});

test("a missing org record is fail-OPEN today (#201)", () => {
  // Asserted as it BEHAVES, not as the docs wish: `recipientAllowedForDev`
  // returns true for a missing org, because "no org record" is a normal
  // condition across the send path. Pinned so the day someone closes #201 this
  // test fails and the persona expectations get revisited deliberately.
  assert.equal(recipientAllowedForDev(undefined, "anyone@example.com"), true);
});
