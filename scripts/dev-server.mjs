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
 * SES and SQS are spoken over the WIRE (`scripts/dev-aws-stubs.mjs`), not
 * swapped for fake adapters. The production `SesEmailSender` and `SqsSendQueue`
 * run verbatim — which matters, because the RFC 8058 headers, the `emailClass`
 * configuration-set routing and the base64url message tags all live in those
 * adapters, and a fake would test the fake instead.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { startAwsStubs } from "./dev-aws-stubs.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PORT = Number(process.env.PORT ?? 4000);
const TABLE = "addressium-dev";
const OUTBOX = resolve(ROOT, ".dev-outbox");
const DEV_ORG = process.env.DEV_ORG ?? "summit";

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
process.env.CONFIRM_URL_BASE ??= `http://localhost:${PORT}/confirm`;
// Handlers resolve these lazily, so an unused one costs nothing — but a MISSING
// one throws `missing env X` from inside a route, which reads as a code bug
// rather than as configuration. Named here so every route is reachable.
process.env.EXPORT_BUCKET ??= "dev-export-bucket";
process.env.AUDIT_BUCKET ??= "dev-audit-bucket";
process.env.SEND_QUEUE_ARN ??= "arn:aws:sqs:us-east-1:000000000000:dev-send";
process.env.SCHEDULER_ROLE_ARN ??= "arn:aws:iam::000000000000:role/dev-scheduler";
process.env.SCHEDULER_GROUP ??= "dev";
process.env.LAUNCH_FN_ARN ??= "arn:aws:lambda:us-east-1:000000000000:function:dev-launch";
process.env.SUBSCRIBER_ACCOUNT_FN ??= "dev-subscriber-account";
process.env.SES_MAX_SEND_RATE ??= "14";
process.env.UNSUBSCRIBE_URL_BASE ??= `http://localhost:${PORT}/unsubscribe`;

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

/**
 * Seed one organization directly into the store (#232).
 *
 * `POST /orgs` is served by the PROVISIONING Lambda, which sits outside the API
 * router table this server mounts — it holds `kms:CreateKey` and
 * `ses:CreateEmailIdentity`, and pulling it into the router would put those
 * grants behind the consolidated API function. So the org is written directly
 * rather than routed, and the journey starts at step one.
 *
 * Written through the real `DynamoStores`, so the item shape is the deployed
 * one; nothing here knows the table layout.
 */
async function seedOrg() {
  const { DynamoStores } = await import(resolve(ROOT, "packages/adapters-aws/dist/index.js"));
  const stores = new DynamoStores(TABLE);
  if (await stores.organizations.get(DEV_ORG)) return;
  await stores.organizations.put({
    orgId: DEV_ORG,
    name: "Dev Org",
    domains: ["dev.example"],
    sesConfigSet: `addressium-${DEV_ORG}`,
    sesTransactionalConfigSet: `addressium-${DEV_ORG}-transactional`,
    ipMode: "shared",
    dmarcPolicy: "none",
    suppressionScope: "hybrid",
    defaultTimezone: "UTC",
    // `prod`, deliberately: a `dev` org is fail-closed against an empty send
    // allowlist (§4.11), so seeding one would make every local send silently
    // return `dev-allowlist` and look like a broken send path.
    environment: "prod",
    setupComplete: true,
  });
  console.log(`dev: seeded org "${DEV_ORG}" (domains: dev.example)`);
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
  const stubs = await startAwsStubs(OUTBOX);

  const api = await import(resolve(ROOT, "services/api/dist/index.js"));
  const sender = await import(resolve(ROOT, "services/sender/dist/index.js"));
  await seedOrg();

  /**
   * Drain the send queue through the REAL sender handler (#232).
   *
   * Polled after each request rather than run as an event-source mapping,
   * because there is no Lambda service here to do it — but the handler itself is
   * the deployed one, receiving the same SQS event shape, so the batch-item
   * failure reporting (#177) and the per-recipient claim logic (#163) are
   * exercised exactly as they are in production.
   */
  const drain = async () => {
    for (let round = 0; round < 20; round++) {
      const msgs = stubs.queue.receive(10);
      if (msgs.length === 0) return;
      try {
        await sender.handler({
          Records: msgs.map((m) => ({ messageId: m.id, receiptHandle: m.id, body: m.body })),
        });
      } catch (e) {
        console.error("dev: sender batch threw", e);
      }
      for (const m of msgs) stubs.queue.delete(m.id);
    }
    console.warn("dev: send queue still not empty after 20 rounds — a fan-out loop?");
  };
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
    // Anything that enqueues is drained before the response returns, so a
    // developer sees the mail in the outbox by the time curl exits rather than
    // wondering whether the send is asynchronous or broken.
    await drain();
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

  Mail:  .dev-outbox/mail.ndjson (the real SES adapter's payload, headers and all)
  Org:   "${DEV_ORG}" is seeded on boot — POST /orgs is served by the provisioning
         Lambda, which is outside the API router, so it is not mounted here.
`);

  const shutdown = () => {
    server.close();
    stubs.close();
    dynaliteServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
