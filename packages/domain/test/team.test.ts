/**
 * Admin team management (#226).
 *
 * The four-role matrix was enforced server-side while exactly one role, at
 * global org scope, was reachable — because the only way a member was ever
 * created was the deploy-time seed. An authorization system that can only ever
 * issue root is not an authorization system.
 *
 * Two guards carry the security weight here, and both are about what the
 * product must refuse to do: it must never hand out the `"*"` scope, and it must
 * never leave a deployment with nobody who can administer it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  TeamError,
  assertGrantable,
  assertNotLastAdmin,
  capabilitiesOf,
  inviteMember,
  setMemberAccess,
  setMemberEnabled,
  type AdminDirectory,
  type TeamMember,
} from "@addressium/domain";

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  username: "u1",
  email: "a@x.com",
  role: "developer_admin",
  orgs: ["summit"],
  enabled: true,
  ...over,
});

/** In-memory directory: records what would have reached Cognito. */
function fakeDirectory(initial: TeamMember[] = []) {
  const members = [...initial];
  const calls: string[] = [];
  const dir: AdminDirectory = {
    async list() {
      return members.map((m) => ({ ...m }));
    },
    async invite(input) {
      calls.push(`invite:${input.email}:${input.role}:${input.orgs.join("|")}`);
      const m = member({ username: `u${members.length + 1}`, ...input });
      members.push(m);
      return m;
    },
    async setAccess(username, input) {
      calls.push(`setAccess:${username}:${input.role}:${input.orgs.join("|")}`);
      const m = members.find((x) => x.username === username)!;
      Object.assign(m, input);
      return { ...m };
    },
    async setEnabled(username, enabled) {
      calls.push(`setEnabled:${username}:${enabled}`);
      members.find((x) => x.username === username)!.enabled = enabled;
    },
  };
  return { dir, calls, members };
}

test('the "*" org scope can never be granted in-app', async () => {
  // This is the wildcard #168 was filed about. A UI that can issue it would undo
  // that fix from the other direction.
  assert.throws(() => assertGrantable({ role: "editor", orgs: ["*"] }), TeamError);
  assert.throws(() => assertGrantable({ role: "editor", orgs: ["summit", "*"] }), TeamError);

  const { dir, calls } = fakeDirectory();
  await assert.rejects(() => inviteMember(dir, { email: "b@x.com", role: "editor", orgs: ["*"] }), TeamError);
  assert.deepEqual(calls, [], "nothing reached the directory");
});

test("a grant with no organization is refused", () => {
  // A member scoped to nothing can sign in and see nothing, which reads as a
  // broken account rather than a deliberate one.
  assert.throws(() => assertGrantable({ role: "analyst", orgs: [] }), TeamError);
  assert.throws(() => assertGrantable({ role: "analyst", orgs: ["  "] }), TeamError);
});

test("an unknown role is refused", () => {
  assert.throws(() => assertGrantable({ role: "superuser", orgs: ["summit"] }), TeamError);
  assert.deepEqual(assertGrantable({ role: "analyst", orgs: [" summit "] }), {
    role: "analyst",
    orgs: ["summit"],
  });
});

test("the last enabled developer admin cannot be demoted or disabled", async () => {
  const only = [member({ username: "u1", role: "developer_admin", enabled: true })];
  assert.throws(() => assertNotLastAdmin(only, "u1", { role: "editor" }), TeamError);
  assert.throws(() => assertNotLastAdmin(only, "u1", { enabled: false }), TeamError);

  const { dir, calls } = fakeDirectory(only);
  await assert.rejects(() => setMemberEnabled(dir, "u1", false), TeamError);
  // The only recovery from locking everyone out is the AWS console — which is
  // precisely the dependency this feature exists to remove.
  assert.deepEqual(calls, []);
});

test("demoting an admin is allowed once another enabled admin exists", async () => {
  const { dir, calls } = fakeDirectory([
    member({ username: "u1", role: "developer_admin" }),
    member({ username: "u2", email: "b@x.com", role: "developer_admin" }),
  ]);
  await setMemberAccess(dir, "u1", { role: "editor", orgs: ["summit"] });
  assert.deepEqual(calls, ["setAccess:u1:editor:summit"]);
});

test("a DISABLED second admin does not count as cover", () => {
  const members = [
    member({ username: "u1", role: "developer_admin", enabled: true }),
    member({ username: "u2", role: "developer_admin", enabled: false }),
  ];
  assert.throws(() => assertNotLastAdmin(members, "u1", { enabled: false }), TeamError);
});

test("a second admin scoped to a different org still counts", () => {
  // Team management is deployment-wide, not per-org, so any enabled admin can
  // restore access.
  const members = [
    member({ username: "u1", orgs: ["summit"] }),
    member({ username: "u2", email: "b@x.com", orgs: ["ledger"] }),
  ];
  assert.doesNotThrow(() => assertNotLastAdmin(members, "u1", { enabled: false }));
});

test("inviting a duplicate address is refused", async () => {
  const { dir } = fakeDirectory([member({ email: "a@x.com" })]);
  await assert.rejects(
    () => inviteMember(dir, { email: "A@X.com", role: "editor", orgs: ["summit"] }),
    TeamError,
  );
});

test("an invite normalizes the address and passes a validated grant through", async () => {
  const { dir, calls } = fakeDirectory();
  const m = await inviteMember(dir, { email: "  New@Example.COM ", role: "support", orgs: ["summit"] });
  assert.equal(m.email, "new@example.com");
  assert.deepEqual(calls, ["invite:new@example.com:support:summit"]);
});

test("an invite without a real address is refused", async () => {
  const { dir, calls } = fakeDirectory();
  await assert.rejects(() => inviteMember(dir, { email: "nope", role: "editor", orgs: ["s"] }), TeamError);
  assert.deepEqual(calls, []);
});

test("capabilitiesOf reports what a role actually grants, so the console can show it", () => {
  const admin = capabilitiesOf("developer_admin");
  const analyst = capabilitiesOf("analyst");

  assert.ok(admin.includes("team:manage"), "only an admin manages the team");
  assert.ok(!analyst.includes("team:manage"));
  assert.deepEqual(analyst, ["reports:view"], "an analyst is read-only");
  assert.ok(admin.length > analyst.length);
});

test("disabling a non-admin needs no cover", async () => {
  const { dir, calls } = fakeDirectory([
    member({ username: "u1", role: "developer_admin" }),
    member({ username: "u2", email: "b@x.com", role: "editor" }),
  ]);
  await setMemberEnabled(dir, "u2", false);
  assert.deepEqual(calls, ["setEnabled:u2:false"]);
});
