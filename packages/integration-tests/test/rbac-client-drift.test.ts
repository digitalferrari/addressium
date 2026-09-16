/**
 * The console's RBAC mirror must match the server matrix.
 *
 * `apps/admin-web/src/rbac.ts` hand-copies the ROLES matrix rather than
 * importing @addressium/rbac — admin-web is a vite bundle and the server
 * package pulls in cedar-wasm, which has no business in a browser. That copy is
 * convenience only (the API enforces), but when it drifts the console hides
 * controls a role does hold, or shows controls it does not and the user gets a
 * 403 where the UI promised a button. Neither side's own tests can see that:
 * admin-web's suite is mocked and asserts against its own copy.
 *
 * So compare the two matrices directly. The client file is read as TEXT because
 * this package compiles with tsc project references and admin-web is not a
 * composite project — importing it would mean tsconfig surgery to assert five
 * lines.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ROLES, type Capability, type RoleName } from "@addressium/rbac";

// Resolved from this module, not process.cwd(): the compiled test runs from
// dist/test/ and cwd differs between `npm test` at the repo root and inside the
// package. dist/test/ -> dist/ -> integration-tests/ -> packages/ -> repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CLIENT_RBAC = path.join(REPO_ROOT, "apps/admin-web/src/rbac.ts");

/**
 * Pull `role: [...]` entries out of the client's ROLES object literal.
 * Deliberately narrow: it parses the one shape the file actually uses, and the
 * guards below turn any other shape into a failure rather than a silent pass.
 */
function parseClientRoles(src: string): Record<string, string[]> {
  const block = src.match(/const ROLES:[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, `could not find the ROLES object literal in ${CLIENT_RBAC}`);

  const out: Record<string, string[]> = {};
  for (const entry of block[1]!.matchAll(/(\w+)\s*:\s*(\[[\s\S]*?\]|\w+)\s*,/g)) {
    const [, role, value] = entry;
    if (value!.startsWith("[")) {
      out[role!] = [...value!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    } else {
      // A reference to a const array declared above (the file hoists EDITOR).
      const decl = src.match(new RegExp(`const ${value}:[^=]*=\\s*(\\[[\\s\\S]*?\\]);`));
      assert.ok(decl, `client ROLES references ${value}, which was not found`);
      out[role!] = [...decl[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    }
  }
  return out;
}

test("admin-web's RBAC mirror matches the server ROLES matrix", () => {
  const src = readFileSync(CLIENT_RBAC, "utf8");
  // A path slip would otherwise parse an empty string into an empty matrix and
  // compare it against nothing.
  assert.ok(src.length > 0, `${CLIENT_RBAC} is empty`);

  const client = parseClientRoles(src);
  const serverRoles = Object.keys(ROLES) as RoleName[];

  assert.deepEqual(
    Object.keys(client).sort(),
    [...serverRoles].sort(),
    "client and server disagree on which roles exist",
  );

  for (const role of serverRoles) {
    const server = [...ROLES[role]].sort();
    const mirrored = [...(client[role] ?? [])].sort();
    assert.deepEqual(
      mirrored,
      server,
      `role "${role}" drifted: admin-web/src/rbac.ts must match packages/rbac/src/roles.ts`,
    );
  }
});

test("admin-web mirrors the full Capability union", () => {
  const src = readFileSync(CLIENT_RBAC, "utf8");
  const union = src.match(/export type Capability =([\s\S]*?);/);
  assert.ok(union, "could not find the Capability union in the client mirror");

  const clientCaps = [...union[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
  const serverCaps = [
    ...new Set(Object.values(ROLES).flatMap((s) => [...s])),
  ].sort() as Capability[];

  // developer_admin holds every capability, so the server matrix is the union.
  assert.deepEqual(
    clientCaps,
    serverCaps,
    "the console's Capability union drifted from the server's",
  );
});

test("the client mirror still refuses a smuggled wildcard", () => {
  // Both sides must treat "*" as a wildcard ONLY as the whole claim; a list
  // containing it must not widen scope. Asserted as source text because the
  // client's grantFromClaims returns null where the server throws, so the two
  // cannot be compared behaviorally.
  const src = readFileSync(CLIENT_RBAC, "utf8");
  assert.match(
    src,
    /includes\("\*"\)/,
    "admin-web/src/rbac.ts lost its wildcard-smuggle guard (#168)",
  );
});
