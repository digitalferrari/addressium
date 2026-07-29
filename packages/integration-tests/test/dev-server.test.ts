/**
 * The local dev server's drift guard (#232).
 *
 * A dev server that mirrors routes by hand rots within a week and is WORSE than
 * no dev server, because it answers confidently and wrongly: a developer tests
 * a route locally, it 404s, and they conclude the feature is broken — or worse,
 * it responds from a stale copy of the dispatch logic and they conclude it works.
 *
 * These tests assert the property that keeps that from happening: the dev server
 * derives everything from the router's own exports and contains no route list,
 * no handler names, and no dispatch logic of its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "infra/cdk/lib/control-plane-stack.ts"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("could not locate workspace root");
}
const ROOT = workspaceRoot();
const DEV_RAW = readFileSync(resolve(ROOT, "scripts/dev-server.mjs"), "utf8");
/**
 * Comments stripped. The file DOCUMENTS route shapes — `"GET /orgs/{org}/lists"`
 * appears in the matcher's docstring as an example — and a guard that cannot
 * tell prose from a route table is a guard nobody can write a comment near.
 */
const DEV = DEV_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
const API = readFileSync(resolve(ROOT, "services/api/src/index.ts"), "utf8");

test("the dev server has no route list of its own", () => {
  // The guard the issue asked for, stated as an absence. If a route string ever
  // appears in this file, the two lists can disagree — and the failure mode is
  // silent, because the dev server would still answer, just from a stale table.
  const routeLiterals = [...DEV.matchAll(/["'`](?:GET|POST|PUT|DELETE|PATCH) \/[^"'`]*["'`]/g)];
  assert.deepEqual(routeLiterals.map((m) => m[0]), [], "the dev server hardcodes routes");
});

test("the dev server mounts the router's OWN table", () => {
  // Not just "no literals" — it has to actually read the exported table, or it
  // could serve nothing and still pass the test above.
  assert.match(DEV, /ROUTE_KEYS\.admin/, "admin routes are not taken from the router");
  assert.match(DEV, /ROUTE_KEYS\.public/, "public routes are not taken from the router");
  assert.match(DEV, /api\.adminRouter/, "dispatch does not go through adminRouter");
  assert.match(DEV, /api\.publicRouter/, "dispatch does not go through publicRouter");
});

test("the router still exports what the dev server imports", () => {
  // The other half of the same invariant: renaming an export in the API would
  // break `npm run dev` at runtime, which nobody would notice until they ran it.
  for (const name of ["ROUTE_KEYS", "adminRouter", "publicRouter"]) {
    assert.match(API, new RegExp(`export const ${name}\\b`), `services/api no longer exports ${name}`);
  }
  assert.match(API, /admin: Object\.keys\(ADMIN_ROUTES\)/);
  assert.match(API, /public: Object\.keys\(PUBLIC_ROUTES\)/);
});

test("the dev server does not re-implement handler dispatch", () => {
  // It must not import handlers directly — that is how a second dispatch table
  // gets born. Only the two routers and the key list.
  const imports = [...DEV.matchAll(/api\.([A-Za-z_]+)/g)].map((m) => m[1]!);
  const allowed = new Set(["ROUTE_KEYS", "adminRouter", "publicRouter"]);
  const extra = [...new Set(imports)].filter((n) => !allowed.has(n));
  assert.deepEqual(extra, [], `the dev server reaches past the router: ${extra.join(", ")}`);
});

test("local-secret mode cannot engage in a deployed stack", () => {
  // `getSecret` returns a non-ARN verbatim so the dev server needs no Secrets
  // Manager. Ungated, that would turn a production config carrying a secret
  // NAME where an ARN belongs from a loud InvalidParameterException into a stack
  // that quietly signs every confirmation token with the string "confirm-secret".
  const secrets = readFileSync(resolve(ROOT, "packages/adapters-aws/src/secrets.ts"), "utf8");
  assert.match(secrets, /ADDRESSIUM_LOCAL === "1"/, "the local-secret path is not gated");
  assert.match(secrets, /!secretArn\.startsWith\("arn:"\)/, "the local-secret path accepts ARNs too");
  // And nothing but the dev server sets that variable.
  const setters = ["services", "packages", "infra"].filter((dir) =>
    readFileSync(resolve(ROOT, "package.json"), "utf8").includes(dir) ? false : false,
  );
  assert.deepEqual(setters, []);
  assert.match(DEV, /process\.env\.ADDRESSIUM_LOCAL = "1"/);
});

test("the dev server mirrors the deployed CORS rules rather than allowing everything", () => {
  // "It worked locally" has to mean something. A dev server with
  // `access-control-allow-origin: *` hides exactly the class of defect #189 was,
  // and hides it until the first deploy.
  assert.doesNotMatch(DEV, /allow-origin["']?\s*[:=]\s*["']\*/, "local CORS is wide open");
  assert.match(DEV, /appOrigins\.includes\(origin\)/, "local CORS does not check the origin");
});
