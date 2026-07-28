/**
 * Route parity for the consolidated API router (#213).
 *
 * 27 single-route Lambdas were collapsed into one function dispatching on API
 * Gateway's `routeKey`. The whole risk of that change is a route registered in
 * CDK with no matching entry in the router's table — which fails at RUNTIME as a
 * 404, i.e. a silently broken console screen, not a build error.
 *
 * This test closes that gap by asserting the two lists agree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Walk up to the workspace root. A fixed `../../..` breaks silently between src
 * and dist (the compiled file sits one directory deeper), and the failure looks
 * like a missing file rather than a bad path.
 */
function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "infra/cdk/lib/control-plane-stack.ts"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("could not locate workspace root");
}
const REPO_ROOT = workspaceRoot();
const STACK = resolve(REPO_ROOT, "infra/cdk/lib/control-plane-stack.ts");
const API = resolve(REPO_ROOT, "services/api/src/index.ts");

/**
 * Read the router's dispatch tables from source rather than importing them.
 * The invariant under test is that two FILES agree, and parsing avoids making
 * the test package depend on a service (which TypeScript project references
 * forbid anyway).
 */
function routerTable(name: "ADMIN_ROUTES" | "PUBLIC_ROUTES"): string[] {
  const src = readFileSync(API, "utf8");
  const start = src.indexOf(`const ${name}: Record<string, RouteHandler> = {`);
  if (start < 0) throw new Error(`${name} not found in services/api/src/index.ts`);
  const body = src.slice(start, src.indexOf("\n};", start));
  return [...body.matchAll(/"((?:GET|POST|PUT|DELETE|PATCH) \/[^"]*)":/g)].map((m) => m[1]!);
}

const ROUTE_KEYS = { admin: routerTable("ADMIN_ROUTES"), public: routerTable("PUBLIC_ROUTES") };

/** Every `adminRoute(id, handler, HttpMethod.X, "/path")` call in the stack. */
function adminRoutesDeclaredInCdk(): string[] {
  const src = readFileSync(STACK, "utf8");
  const re = /adminRoute\(\s*"[^"]+",\s*"[^"]+",\s*HttpMethod\.([A-Z]+),\s*"([^"]+)"/g;
  const out: string[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(`${m[1]} ${m[2]}`);
  return out;
}

test("every admin route in CDK has a handler in the router", () => {
  const declared = adminRoutesDeclaredInCdk();
  assert.ok(declared.length > 0, "regex must actually match the CDK route calls");
  const missing = declared.filter((r) => !ROUTE_KEYS.admin.includes(r));
  assert.deepEqual(missing, [], `routes with no handler (would 404 at runtime): ${missing.join(", ")}`);
});

test("the router declares no handler for a route CDK never registers", () => {
  // Dead entries are harmless at runtime but signal a rename that only got
  // half-applied — which is how the *next* route goes missing.
  const declared = adminRoutesDeclaredInCdk();
  const orphaned = ROUTE_KEYS.admin.filter((r) => !declared.includes(r));
  assert.deepEqual(orphaned, [], `handlers with no route: ${orphaned.join(", ")}`);
});

test("admin and public dispatch tables are disjoint", () => {
  // The public router runs unauthenticated. If an admin routeKey leaked into
  // its table, that handler would be reachable without a JWT — the per-route
  // authorizer is what enforces the boundary, and this keeps the two aligned.
  const overlap = ROUTE_KEYS.public.filter((r) => ROUTE_KEYS.admin.includes(r));
  assert.deepEqual(overlap, [], `route in BOTH tables: ${overlap.join(", ")}`);
});

test("the admin table covers every route the console calls", () => {
  // Spot-check the screens most likely to be missed in a rename.
  for (const key of [
    "GET /orgs/{org}/campaigns",
    "GET /orgs/{org}/subscribers",
    "GET /orgs/{org}/segments",
    "GET /orgs/{org}/templates",
    "POST /orgs/{org}/import",
  ]) {
    assert.ok(ROUTE_KEYS.admin.includes(key), `console route missing: ${key}`);
  }
});
