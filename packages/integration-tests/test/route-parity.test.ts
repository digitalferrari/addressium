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

test("the subscriber-account provisioner is reachable from NO route (#23)", () => {
  // It is the only code in the product that may write to an operator's user
  // directory, and it holds the IAM grant to prove it. Mapping it to a route —
  // in either table — would put that grant behind an HTTP endpoint, which is
  // the exposure the split exists to remove. `confirmHandler` invokes it
  // directly instead.
  const src = readFileSync(API, "utf8");
  assert.match(src, /export async function subscriberAccountHandler/, "the handler exists");
  for (const [table, keys] of Object.entries(ROUTE_KEYS)) {
    for (const key of keys) {
      const entry = new RegExp(`"${key.replace(/[/{}]/g, "\\$&")}":\\s*(\\w+)`);
      const handler = src.match(entry)?.[1];
      assert.notEqual(handler, "subscriberAccountHandler", `routed in ${table} as ${key}`);
    }
  }
  // ...and CDK must not register a route for it either.
  assert.doesNotMatch(readFileSync(STACK, "utf8"), /adminRoute\([^)]*subscriberAccountHandler/);
});

/**
 * No public SPA may call an authenticated route (#124).
 *
 * The subscriber site's browse page called the ADMIN `GET /orgs/{org}/lists`,
 * which sits behind the console's JWT authorizer — so the front door of the
 * entire public site could only ever have returned 401. Nothing caught it,
 * because both halves were individually correct: the route existed, the client
 * called a real path, and only the AUTH POSTURE between them was wrong.
 *
 * This asserts the posture. It reads the CDK stack for which paths carry an
 * authorizer, and the unauthenticated SPAs for which paths they call.
 */
function publicPaths(): Set<string> {
  const src = readFileSync(STACK, "utf8");
  const open = new Set<string>();
  for (const m of src.matchAll(/api\.addRoutes\(\{(.*?)\}\);/gs)) {
    const body = m[1]!;
    if (/authorizer/.test(body)) continue;
    const p = /path:\s*"([^"]+)"/.exec(body);
    if (p) open.add(p[1]!);
  }
  return open;
}

/** `/orgs/summit/directory` -> `/orgs/{org}/directory`, so it matches a template. */
const templatize = (path: string): string =>
  path.replace(/\$\{[^}]+\}/g, "{p}").replace(/\{[^}]+\}/g, "{p}");

test("every route the unauthenticated SPAs call is registered WITHOUT an authorizer", () => {
  const open = new Set([...publicPaths()].map(templatize));
  assert.ok(open.size > 0, "regex must actually match the public route registrations");

  for (const rel of ["apps/subscriber-web/src/api.ts", "apps/public-web/src/App.tsx"]) {
    const src = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    // Template literals of the form `/orgs/${ORG}/thing` or `/signup`.
    for (const m of src.matchAll(/`(\/[a-zA-Z0-9/${}_.-]*)`/g)) {
      const raw = m[1]!.split("?")[0]!;
      if (!raw.startsWith("/")) continue;
      const path = templatize(raw);
      assert.ok(
        open.has(path),
        `${rel} calls ${raw} (${path}), which is NOT a public route — it will 401`,
      );
    }
  }
});
