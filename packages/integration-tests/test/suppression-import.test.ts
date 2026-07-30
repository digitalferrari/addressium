/**
 * The SES suppression-list import at the boundaries it can actually break (#240).
 *
 * Three of them, and the domain test covers none:
 *
 *  1. **Pagination.** SES returns the account suppression list a page at a time.
 *     A reader that stops early reports success having imported a fraction, and
 *     the addresses it missed are exactly the ones the next campaign mails.
 *  2. **The DynamoDB batch write.** `BatchWriteItem` rejects a whole request over
 *     25 items or containing duplicate keys, and returns `UnprocessedItems` with a
 *     200 when throttled. Each of those, handled wrongly, silently drops
 *     suppressions.
 *  3. **The route.** Authorization, and that the reader is the deployment's own
 *     SES account rather than anything the caller names.
 *
 * Asserted against real command inputs and a real DynamoDB API (dynalite), not
 * against stubs of our own functions.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoStores, SesSuppressionListReader } from "@addressium/adapters-aws";
import { importSuppressionList, type Clock, type SuppressedDestination } from "@addressium/domain";
import type { SuppressionEntry } from "@addressium/core";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-suppression-import";
const ORG = "summit";
const NOW = "2026-07-30T12:00:00.000Z";
const clock: Clock = { now: () => new Date(NOW) };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let client: DynamoDBClient;
let dynEndpoint: string;
let api: typeof import("@addressium/svc-api");

/** Captures the commands sent to a client and answers them from a script. */
function fakeSes(pages: Array<Record<string, unknown>>) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  return {
    calls,
    send: async (cmd: { input: Record<string, unknown> }) => {
      calls.push(cmd.input);
      return pages[i++] ?? {};
    },
  };
}

const summary = (EmailAddress: string, Reason = "BOUNCE", LastUpdateTime?: Date) => ({
  EmailAddress,
  Reason,
  ...(LastUpdateTime ? { LastUpdateTime } : {}),
});

const drain = async (r: { list(): AsyncIterable<SuppressedDestination> }) => {
  const out: SuppressedDestination[] = [];
  for await (const d of r.list()) out.push(d);
  return out;
};

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dynEndpoint = endpoint;

  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint;
  process.env.AWS_REGION ??= "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "local";
  process.env.AWS_SECRET_ACCESS_KEY = "local";
  process.env.TABLE_NAME = TABLE;

  const throughput = { ReadCapacityUnits: 1, WriteCapacityUnits: 1 };
  const gsi = (n: string) => ({
    IndexName: n,
    KeySchema: [
      { AttributeName: `${n}pk`, KeyType: "HASH" as const },
      { AttributeName: `${n}sk`, KeyType: "RANGE" as const },
    ],
    Projection: { ProjectionType: "ALL" as const },
    ProvisionedThroughput: throughput,
  });
  client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  await client.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PROVISIONED",
      ProvisionedThroughput: throughput,
      AttributeDefinitions: ["pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk", "gsi3pk", "gsi3sk"].map(
        (AttributeName) => ({ AttributeName, AttributeType: "S" as const }),
      ),
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" as const },
        { AttributeName: "sk", KeyType: "RANGE" as const },
      ],
      GlobalSecondaryIndexes: [gsi("gsi1"), gsi("gsi2"), gsi("gsi3")],
    }),
  );

  api = await import("@addressium/svc-api");
});

after(() => server?.close());

// ---------------------------------------------------------------------------
// 1. Pagination — the reader
// ---------------------------------------------------------------------------

test("the reader follows NextToken to the end of the list", async () => {
  const ses = fakeSes([
    { SuppressedDestinationSummaries: [summary("a@example.com")], NextToken: "t1" },
    { SuppressedDestinationSummaries: [summary("b@example.com")], NextToken: "t2" },
    { SuppressedDestinationSummaries: [summary("c@example.com")] },
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const got = await drain(new SesSuppressionListReader({}, ses as any));

  assert.deepEqual(
    got.map((d) => d.email),
    ["a@example.com", "b@example.com", "c@example.com"],
  );
  // The token has to go back out, or every page is page one — an infinite loop
  // rather than a truncation, which is at least loud.
  assert.deepEqual(
    ses.calls.map((c) => c.NextToken),
    [undefined, "t1", "t2"],
  );
});

test("an empty page WITH a token does not end the walk", async () => {
  // SES can return a page whose entries were all filtered by `Reasons`. Stopping
  // on the empty page silently truncates the list, and the import reports success
  // for the fraction it read.
  const ses = fakeSes([
    { SuppressedDestinationSummaries: [], NextToken: "t1" },
    { SuppressedDestinationSummaries: [summary("late@example.com")] },
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const got = await drain(new SesSuppressionListReader({}, ses as any));

  assert.deepEqual(
    got.map((d) => d.email),
    ["late@example.com"],
  );
  assert.equal(ses.calls.length, 2);
});

test("reasons and page size are passed through, and an addressless entry is skipped", async () => {
  const ses = fakeSes([
    {
      SuppressedDestinationSummaries: [
        summary("has@example.com", "COMPLAINT", new Date("2023-04-05T06:07:08.000Z")),
        // No EmailAddress: SES always supplies one, so this means the shape moved
        // under us. Inventing a key would write a suppression for "".
        { Reason: "BOUNCE" },
      ],
    },
  ]);
  const got = await drain(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new SesSuppressionListReader({ reasons: ["COMPLAINT"], pageSize: 500 }, ses as any),
  );

  assert.deepEqual(got, [
    { email: "has@example.com", reason: "COMPLAINT", at: "2023-04-05T06:07:08.000Z" },
  ]);
  assert.deepEqual(ses.calls[0], { Reasons: ["COMPLAINT"], PageSize: 500 });
});

// ---------------------------------------------------------------------------
// 2. The DynamoDB batch write
// ---------------------------------------------------------------------------

const entry = (email: string): SuppressionEntry => ({
  orgId: ORG,
  email,
  source: "bounce",
  scope: "global",
  addedAt: NOW,
});

test("addMany chunks at DynamoDB's 25-item limit and every entry lands", async () => {
  const stores = new DynamoStores(TABLE, client);
  const emails = Array.from({ length: 60 }, (_, i) => `chunk${i}@example.com`);
  await stores.suppression.addMany(emails.map(entry));

  // Over 25 in one request, DynamoDB rejects the WHOLE batch — not a partial
  // write — so this is the difference between 60 suppressions and none.
  for (const e of [emails[0]!, emails[24]!, emails[25]!, emails[59]!]) {
    assert.equal(await stores.suppression.isSuppressed(ORG, e), true, e);
  }
});

test("a duplicate inside one chunk does not reject the batch", async () => {
  const stores = new DynamoStores(TABLE, client);
  // A whole-batch ValidationException, if undeduped. The provider paginates, and a
  // page boundary can repeat an address under concurrent modification, so this is
  // reachable from real input rather than only from a bad caller.
  await stores.suppression.addMany([
    entry("dupe@example.com"),
    entry("DUPE@example.com"),
    entry("other@example.com"),
  ]);
  assert.equal(await stores.suppression.isSuppressed(ORG, "dupe@example.com"), true);
  assert.equal(await stores.suppression.isSuppressed(ORG, "other@example.com"), true);
});

/**
 * A DynamoDB endpoint that answers `BatchWriteItem` with throttling leftovers.
 *
 * At the WIRE, not by stubbing the client: `UnprocessedItems` is the one response
 * where "succeeded" and "silently dropped suppressions" are the same HTTP 200,
 * and the SDK's own unmarshalling is part of what has to be right. dynalite never
 * throttles, so the behaviour is otherwise unreachable — and a stubbed
 * `DynamoDBClient` cannot be used either, because `DynamoDBDocumentClient.from`
 * resolves middleware off the client it wraps.
 *
 * `leftoverFor` returns how many of the request's items to hand back unwritten;
 * the rest are forwarded to dynalite and really written.
 */
function startThrottlingShim(
  upstream: string,
  leftoverFor: (call: number, items: unknown[]) => number,
): Promise<{ server: Server; calls: number[] }> {
  const calls: number[] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (String(req.headers["x-amz-target"] ?? "").endsWith(".BatchWriteItem")) {
      const parsed = JSON.parse(body || "{}") as {
        RequestItems: Record<string, unknown[]>;
      };
      const items = parsed.RequestItems[TABLE] ?? [];
      calls.push(items.length);
      const keep = leftoverFor(calls.length, items);
      if (keep > 0) {
        // Real DynamoDB writes the items it DID accept and returns only the rest,
        // so the shim forwards the accepted slice and reports the remainder. A
        // short-circuit that wrote nothing would test a throttle DynamoDB never
        // produces, and would hide the bug where a retry resends the leftover but
        // the accepted items were silently dropped.
        const accepted = items.slice(keep);
        if (accepted.length > 0) {
          await forward(upstream, req, JSON.stringify({ RequestItems: { [TABLE]: accepted } }));
        }
        res.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
        res.end(JSON.stringify({ UnprocessedItems: { [TABLE]: items.slice(0, keep) } }));
        return;
      }
    }
    const fwd = httpRequest(
      `${upstream}${req.url ?? "/"}`,
      {
        method: req.method,
        headers: { ...req.headers, "content-length": String(Buffer.byteLength(body)) },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 500, up.headers);
        up.pipe(res);
      },
    );
    fwd.end(body);
  });
  return new Promise((r) => server.listen(0, () => r({ server, calls })));
}

/** Replay one request upstream with a rewritten body, and wait for it to land. */
const forward = (upstream: string, req: IncomingMessage, body: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const fwd = httpRequest(
      `${upstream}${req.url ?? "/"}`,
      {
        method: req.method,
        headers: { ...req.headers, "content-length": String(Buffer.byteLength(body)) },
      },
      (up) => {
        up.resume();
        up.on("end", () => resolve());
      },
    );
    fwd.on("error", reject);
    fwd.end(body);
  });

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });

const clientFor = (endpoint: string) =>
  new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
  });

test("UnprocessedItems are retried rather than reported as written", async () => {
  // Hand back one leftover on the first two calls, then accept everything.
  const { server, calls } = await startThrottlingShim(dynEndpoint, (call) => (call <= 2 ? 1 : 0));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stores = new DynamoStores(TABLE, clientFor(endpoint));
    await stores.suppression.addMany([entry("t1@example.com"), entry("t2@example.com")]);

    assert.deepEqual(calls, [2, 1, 1], "the leftover alone is resent, not the whole chunk");
    // Written for real against dynalite on the third pass — this is the assertion
    // that a "handled" retry actually persisted something.
    const direct = new DynamoStores(TABLE, client);
    assert.equal(await direct.suppression.isSuppressed(ORG, "t1@example.com"), true);
    assert.equal(await direct.suppression.isSuppressed(ORG, "t2@example.com"), true);
  } finally {
    server.close();
  }
});

test("a batch that never drains throws instead of claiming success", async () => {
  const { server, calls } = await startThrottlingShim(dynEndpoint, (_call, items) => items.length);
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stores = new DynamoStores(TABLE, clientFor(endpoint));
    // The alternative is the failure this whole feature exists to prevent: the
    // import reports N suppressions written and the next campaign mails them.
    await assert.rejects(
      () => stores.suppression.addMany([entry("never@example.com")]),
      /did not drain/,
    );
    assert.ok(calls.length > 1, "it retried before giving up");
    const direct = new DynamoStores(TABLE, client);
    assert.equal(await direct.suppression.isSuppressed(ORG, "never@example.com"), false);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// 3. The route
// ---------------------------------------------------------------------------

function importEvent(body: Record<string, unknown>, role = "developer_admin", orgs = ORG) {
  return {
    pathParameters: { org: ORG },
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "POST", sourceIp: "203.0.113.9" },
      authorizer: { jwt: { claims: { "custom:role": role, "custom:orgs": orgs, sub: "admin-1" } } },
    },
  };
}

test("the route imports through the injected reader and reports what it wrote", async () => {
  const reader = {
    list: async function* () {
      yield { email: "route1@example.com", reason: "BOUNCE" };
      yield { email: "route2@example.com", reason: "COMPLAINT" };
      yield { email: "route3@example.com", reason: "MYSTERY" };
    },
  };
  const res = await api.importSuppressionHandler(importEvent({}), { reader });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as {
    read: number;
    written: number;
    unmapped: { email: string }[];
    dryRun: boolean;
  };
  assert.equal(body.read, 3);
  assert.equal(body.written, 2);
  assert.deepEqual(body.unmapped, [{ email: "route3@example.com", reason: "MYSTERY" }]);
  assert.equal(body.dryRun, false);

  const stores = new DynamoStores(TABLE, client);
  assert.equal(await stores.suppression.isSuppressed(ORG, "route1@example.com"), true);
  assert.equal(await stores.suppression.isSuppressed(ORG, "route3@example.com"), false);
});

test("a dry run writes nothing", async () => {
  const reader = {
    list: async function* () {
      yield { email: "dry@example.com", reason: "BOUNCE" };
    },
  };
  const res = await api.importSuppressionHandler(importEvent({ dryRun: true }), { reader });

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).written, 1);
  const stores = new DynamoStores(TABLE, client);
  assert.equal(await stores.suppression.isSuppressed(ORG, "dry@example.com"), false);
});

test("authorization is enforced, and it is scoped to the org in the path", async () => {
  const reader = {
    list: async function* () {
      yield { email: "never-read@example.com", reason: "BOUNCE" };
    },
  };
  // These entries are GLOBAL — a caller who can write them affects every org in
  // the deployment, so the check on this route is not a formality. Deleting
  // `requireGrant` must fail here.
  // `support` and `editor` hold `subscribers:manage` — which the sibling import
  // routes use — so guarding this one with that capability would have let a
  // support agent write global suppressions for the whole deployment. It requires
  // `suppression:manage`, which only developer_admin has.
  for (const role of ["analyst", "support", "editor"]) {
    const res = await api.importSuppressionHandler(importEvent({}, role), { reader });
    assert.equal(res.statusCode, 403, role);
  }
  const other = await api.importSuppressionHandler(importEvent({}, "developer_admin", "elsewhere"), {
    reader,
  });
  assert.equal(other.statusCode, 403, "right role, wrong org");

  const claimless = await api.importSuppressionHandler(
    { pathParameters: { org: ORG }, body: "{}", requestContext: { http: { method: "POST" } } },
    { reader },
  );
  assert.equal(claimless.statusCode, 403, "no claims at all");

  const stores = new DynamoStores(TABLE, client);
  assert.equal(await stores.suppression.isSuppressed(ORG, "never-read@example.com"), false);
});

// ---------------------------------------------------------------------------
// 4. Security regressions on the import routes
// ---------------------------------------------------------------------------

test("the preview route refuses a decompression bomb", async () => {
  // This route had NO size cap at all, so API Gateway's 10MB ceiling was the
  // only bound on the compressed input — roughly 10GB decompressed.
  const { gzipSync } = await import("node:zlib");
  const bomb = gzipSync(Buffer.alloc(300 * 1024 * 1024, 0x41));
  const res = await api.importPreviewHandler({
    pathParameters: { org: ORG },
    body: JSON.stringify({ fileBase64: Buffer.from(bomb).toString("base64") }),
    requestContext: {
      http: { method: "POST", sourceIp: "203.0.113.9" },
      authorizer: { jwt: { claims: { "custom:role": "developer_admin", "custom:orgs": ORG, sub: "a" } } },
    },
  });
  assert.ok(res.statusCode >= 400 && res.statusCode < 500, `got ${res.statusCode}`);
  assert.match(res.body, /decompresses to more than/);
});

test("the async route refuses a batchId that is not one", async () => {
  // The batch id becomes an S3 object key and a DynamoDB sort key.
  const bad = ["../otherorg/imp_1", "a".repeat(200), "has space", "with/slash", ""];
  for (const batchId of bad) {
    const res = await api.importAsyncHandler(
      {
        pathParameters: { org: ORG },
        body: JSON.stringify({ batchId, plan: { columns: {} } }),
        requestContext: {
          http: { method: "POST", sourceIp: "203.0.113.9" },
          authorizer: {
            jwt: { claims: { "custom:role": "developer_admin", "custom:orgs": ORG, sub: "a" } },
          },
        },
      },
      { invoke: async () => assert.fail(`the job was queued for batchId ${JSON.stringify(batchId)}`) },
    );
    assert.equal(res.statusCode, 400, `batchId ${JSON.stringify(batchId)} was accepted`);
  }
});

test("a well-formed batchId — including the one the upload route issues — is accepted", async () => {
  let queued: unknown;
  const res = await api.importAsyncHandler(
    {
      pathParameters: { org: ORG },
      body: JSON.stringify({
        batchId: "imp_2026-07-30T12:00:00.000Z_ab12cd34",
        plan: { columns: {} },
      }),
      requestContext: {
        http: { method: "POST", sourceIp: "203.0.113.9" },
        authorizer: {
          jwt: { claims: { "custom:role": "developer_admin", "custom:orgs": ORG, sub: "a" } },
        },
      },
    },
    { invoke: async (p) => void (queued = p) },
  );
  assert.equal(res.statusCode, 202);
  assert.equal(
    (queued as { sourceKey: string }).sourceKey,
    "imports/summit/imp_2026-07-30T12:00:00.000Z_ab12cd34",
  );
});
