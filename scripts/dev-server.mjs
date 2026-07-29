/**
 * addressium local dev server (#232, compendium item 61).
 *
 * `npm run dev` — an HTTP server that mounts the **same route table** the Lambda
 * router dispatches on, backed by dynalite and an on-disk mail outbox. No AWS
 * credentials, no network egress, no Docker.
 *
 * ## Why this exists
 *
 * Until now every behaviour question was answered by reading code or by a deploy
 * nobody has ever performed. Several of the P0s in #206 — a dead event plane,
 * RBAC claims never arriving, missing CORS — were design-level breakage that one
 * five-minute local request would have exposed, and `npm test` could not see
 * any of them because it calls domain functions with pre-digested inputs.
 *
 * ## Why it cannot drift
 *
 * The route table is IMPORTED, not mirrored. `ROUTE_KEYS` comes from
 * `services/api/src/index.ts`, the patterns are compiled from those strings, and
 * dispatch goes through the same `adminRouter` / `publicRouter` the Lambda uses.
 * Adding a route to the router makes it reachable here with no change to this
 * file; `packages/integration-tests/test/dev-server.test.ts` fails if that stops
 * being true. A dev server that mirrors routes by hand rots within a week and is
 * worse than none, because it answers confidently and wrongly.
 *
 * ## What is faked, and what is not
 *
 * | Real | Faked |
 * |---|---|
 * | Every route handler, verbatim | DynamoDB → dynalite (in-process) |
 * | The domain and adapter code they call | Secrets Manager → a literal value |
 * | RBAC (Cedar), validation, CORS | SES → newline-delimited JSON in `.dev-outbox/` |
 *
 * The **send queue is not faked**, and that is a known gap: routes that enqueue
 * to SQS will fail locally. See the note printed at startup and #232.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, appendFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PORT = Number(process.env.PORT ?? 4000);
const TABLE = "addressium-dev";
const OUTBOX = resolve(ROOT, ".dev-outbox");

// ---------------------------------------------------------------------------
// Environment. Set BEFORE importing the API, because its module-level singletons
// read these at first use and the SDK resolves endpoints from the process env.
// ---------------------------------------------------------------------------
process.env.ADDRESSIUM_LOCAL = "1";
process.env.TABLE_NAME = TABLE;
process.env.AWS_REGION ??= "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "local";
process.env.AWS_SECRET_ACCESS_KEY = "local";
process.env.AWS_SESSION_TOKEN = "";
// Not an ARN, so `getSecret` returns it verbatim — see adapters-aws/secrets.ts.
// That path refuses to engage unless ADDRESSIUM_LOCAL is set, so a mis-set
// production ARN still fails loudly rather than signing with its own name.
process.env.CONFIRM_SECRET_ARN ??= "local-dev-confirm-secret";
process.env.WEBHOOK_SECRET_ARN ??= "local-dev-webhook-secret";
process.env.UNSUBSCRIBE_URL_BASE ??= `http://localhost:${PORT}/unsubscribe`;
process.env.PUBLIC_SITE_BASE ??= `http://localhost:${PORT}`;
process.env.APP_ORIGINS ??= "http://localhost:5173,http://localhost:5174,http://localhost:5175";

const dynalite = require("dynalite");

/**
 * The table, with the same key schema and the same three GSIs as the CDK stack.
 *
 * A missing GSI here is not cosmetic — it is exactly the class of defect a real
 * deploy hits: a query against an index that does not exist fails at runtime,
 * only on the code path that uses it. This mirrors `control-plane-stack.ts`.
 */
async function startDynalite() {
  const server = dynalite({ createTableMs: 0 });
  await new Promise((r) => server.listen(0, r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint;

  const throughput = { ReadCapacityUnits: 1, WriteCapacityUnits: 1 };
  const gsi = (n) => ({
    IndexName: n,
    KeySchema: [
      { AttributeName: `${n}pk`, KeyType: "HASH" },
      { AttributeName: `${n}sk`, KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "ALL" },
    ProvisionedThroughput: throughput,
  });
  await new DynamoDBClient({
    endpoint,
    region: process.env.AWS_REGION,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }).send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PROVISIONED",
      ProvisionedThroughput: throughput,
      AttributeDefinitions: ["pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk", "gsi3pk", "gsi3sk"].map(
        (AttributeName) => ({ AttributeName, AttributeType: "S" }),
      ),
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [gsi("gsi1"), gsi("gsi2"), gsi("gsi3")],
    }),
  );
  return server;
}

// ---------------------------------------------------------------------------
// Route matching, compiled from the router's own table
// ---------------------------------------------------------------------------

/**
 * Turn `"GET /orgs/{org}/lists"` into a matcher.
 *
 * Static segments are compared literally and `{name}` captures one segment, the
 * same shape API Gateway uses. Longest static prefix wins, so
 * `/orgs/{org}/campaigns/{id}` never shadows a more specific literal route.
 */
function compile(routeKey) {
  const [method, path] = routeKey.split(" ");
  const parts = path.split("/").filter(Boolean);
  return {
    routeKey,
    method,
    parts,
    /** Static segments, used to rank candidates. */
    specificity: parts.filter((p) => !p.startsWith("{")).length,
  };
}

function match(routes, method, path) {
  const got = path.split("/").filter(Boolean);
  const candidates = routes
    .filter((r) => r.method === method && r.parts.length === got.length)
    .sort((a, b) => b.specificity - a.specificity);
  for (const r of candidates) {
    const params = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      const p = r.parts[i];
      if (p.startsWith("{")) params[p.slice(1, -1)] = decodeURIComponent(got[i]);
      else if (p !== got[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: r, params };
  }
  return undefined;
}

// ---------------------------------------------------------------------------

const readBody = (req) =>
  new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res(b));
  });

/**
 * The claims the API would have received from the Cognito JWT authorizer.
 *
 * Overridable so a developer can reproduce a scoped-role bug — `DEV_ROLE=analyst
 * DEV_ORGS=summit npm run dev` — rather than only ever exercising the happy path
 * with full reach, which is how #168's cross-tenant escalation survived review.
 * Valid roles are the four in `packages/rbac`: developer_admin, editor, analyst,
 * support.
 */
const devClaims = () => ({
  sub: process.env.DEV_SUB ?? "local-dev-user",
  token_use: "id",
  "custom:role": process.env.DEV_ROLE ?? "developer_admin",
  "custom:orgs": process.env.DEV_ORGS ?? "*",
});

async function main() {
  const dynaliteServer = await startDynalite();
  rmSync(OUTBOX, { recursive: true, force: true });
  mkdirSync(OUTBOX, { recursive: true });

  const api = await import(resolve(ROOT, "services/api/dist/index.js"));
  const adminRoutes = api.ROUTE_KEYS.admin.map(compile);
  const publicRoutes = api.ROUTE_KEYS.public.map(compile);
  const appOrigins = process.env.APP_ORIGINS.split(",").map((o) => o.trim());

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const origin = req.headers.origin;
    // Mirrors the deployed CORS configuration rather than allowing everything:
    // "it worked locally" has to mean something, and a permissive local server
    // hides exactly the class of defect #189 was.
    const cors = {
      ...(origin && appOrigins.includes(origin)
        ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" }
        : {}),
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      vary: "origin",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }

    const hit =
      match(publicRoutes, req.method, url.pathname) ?? match(adminRoutes, req.method, url.pathname);
    if (!hit) {
      res.writeHead(404, { ...cors, "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }));
    }
    const isPublic = publicRoutes.includes(hit.route);

    const event = {
      body: await readBody(req),
      queryStringParameters: Object.fromEntries(url.searchParams),
      pathParameters: hit.params,
      headers: req.headers,
      requestContext: {
        routeKey: hit.route.routeKey,
        http: { method: req.method, sourceIp: "127.0.0.1", userAgent: req.headers["user-agent"] ?? "dev" },
        // Public routes are unauthenticated in the deployed stack too, so
        // handing them claims here would make a missing authorizer invisible.
        ...(isPublic ? {} : { authorizer: { jwt: { claims: devClaims() } } }),
      },
    };

    let result;
    try {
      result = await (isPublic ? api.publicRouter(event) : api.adminRouter(event));
    } catch (e) {
      console.error(`${req.method} ${url.pathname} threw`, e);
      result = { statusCode: 500, headers: {}, body: JSON.stringify({ error: String(e) }) };
    }
    console.log(`${req.method} ${url.pathname} → ${result.statusCode}`);
    res.writeHead(result.statusCode, { ...cors, ...result.headers });
    res.end(result.body);
  });

  await new Promise((r) => server.listen(PORT, r));

  console.log(`
  addressium dev — http://localhost:${PORT}

  ${adminRoutes.length} admin + ${publicRoutes.length} public routes, mounted from the
  SAME table services/api dispatches on. DynamoDB is dynalite (in-process, wiped
  on restart). Mail is appended to .dev-outbox/mail.ndjson.

  Point the SPAs at it:   VITE_API_BASE=http://localhost:${PORT} npm run dev -w apps/admin-web
  Act as a scoped role:   DEV_ROLE=analyst DEV_ORGS=summit npm run dev

  KNOWN GAP (#232): routes that enqueue to SQS — launching a campaign — are not
  served, because there is no local queue. The signup → confirm → opt-in half of
  the journey works; the send half does not yet.
`);

  const shutdown = () => {
    server.close();
    dynaliteServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Where the local SES stand-in files a message (see adapters-aws/ses.ts). */
export function devOutboxAppend(message) {
  mkdirSync(OUTBOX, { recursive: true });
  appendFileSync(resolve(OUTBOX, "mail.ndjson"), `${JSON.stringify(message)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
