/**
 * Service-level: the four API-key routes, driven through the exported handlers.
 *
 * The domain tests call `issueApiKey`/`authenticateApiKey` directly, which
 * BYPASSES zod, RBAC and `fail()`. That leaves the things that only exist at the
 * wire unexercised, and each of them is load-bearing for a credential surface:
 *
 *  1. **The capability gate, in both directions.** All four routes are
 *     `apikeys:manage` — INCLUDING the GET, unlike every other registry in the
 *     repo, whose reads are `reports:view`. A credential inventory names every
 *     integration with machine access and what each may do; it is not a report.
 *     Route parity is satisfied by an empty handler, so nothing else would catch
 *     a read that quietly fell back to `reports:view`.
 *  2. **`createdBy` comes from the verified JWT**, not the body. A field saying
 *     who issued a credential is worth nothing if the issuer can write it.
 *  3. **The error contract (#265).** A duplicate keyId and a double revoke are
 *     `InvalidInputError` → 400 carrying the sentence the operator must read. A
 *     bad key at `verify` is a 400 with ONE sentence for every cause. If any of
 *     these were a bare `Error` they would be a 500 and a generic sentence.
 *  4. **No response ever carries the plaintext or the digest** except the single
 *     create response — asserted against the real JSON body rather than against
 *     an object the domain returned.
 *
 * Against a real DynamoDB API (dynalite) and real `DynamoStores`, so the
 * `APIKEY#` prefix query and the `APIKEYHASH#` lookup item are exercised through
 * the handler path the console actually calls.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoStores } from "@addressium/adapters-aws";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-api-keys-route";
const ORG = "summit";
const OTHER_ORG = "northwind";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let api: typeof import("@addressium/svc-api");

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Loopback dynalite. `AWS_REGION` and the credentials below are placeholders
  // the SDK demands before it will sign anything; nothing is sent off-box and
  // none of them names a deployment target.
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
  const client = new DynamoDBClient({
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

  const stores = new DynamoStores(TABLE, client);
  for (const orgId of [ORG, OTHER_ORG]) {
    await stores.organizations.put({
      orgId,
      name: orgId,
      domains: ["example.com"],
      sesConfigSet: "cs",
      ipMode: "shared",
      suppressionScope: "hybrid",
      defaultTimezone: "UTC",
      setupComplete: true,
    });
  }

  api = await import("@addressium/svc-api");
});

after(() => server?.close());

const claims = (role: string, orgs: string, sub: string) => ({
  authorizer: { jwt: { claims: { "custom:role": role, "custom:orgs": orgs, sub } } },
});

const postEvent = (
  body: Record<string, unknown>,
  role = "developer_admin",
  orgs = ORG,
  sub = "admin-1",
) => ({
  body: JSON.stringify(body),
  requestContext: { http: { method: "POST", sourceIp: "203.0.113.7" }, ...claims(role, orgs, sub) },
});

const getEvent = (role = "developer_admin", orgs = ORG, orgId = ORG) => ({
  pathParameters: { org: orgId },
  requestContext: { http: { method: "GET", sourceIp: "203.0.113.7" }, ...claims(role, orgs, "admin-1") },
});

interface KeyView {
  keyId: string;
  name: string;
  scopes: string[];
  displayPrefix: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revoked: boolean;
}

test("POST issues a key, and the plaintext is in that response and no other", async () => {
  const res = await api.apiKeysHandler(
    postEvent({
      orgId: ORG,
      keyId: "billing-sync",
      name: "Billing entitlement sync",
      scopes: ["entitlement:write"],
    }),
  );
  assert.equal(res.statusCode, 200);
  const issued = JSON.parse(res.body) as { key: KeyView; plaintext: string };
  assert.match(issued.plaintext, /^ak_/);
  // Taken from the verified JWT, not from the body — the body never named it.
  assert.equal(issued.key.createdBy, "admin-1");
  assert.equal(issued.key.lastUsedAt, undefined, "issuance is not a use");

  // The LIST response — the actual JSON on the wire — carries neither the key
  // nor its digest. Asserted on the raw body so a field added later that leaked
  // either one fails here.
  const list = await api.apiKeysHandler(getEvent());
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.includes(issued.plaintext), false, "plaintext leaked into the list");
  assert.equal(list.body.includes("keyHash"), false, "digest leaked into the list");
  const rows = JSON.parse(list.body) as KeyView[];
  assert.deepEqual(rows.map((r) => r.keyId), ["billing-sync"]);
  assert.equal(rows[0]?.lastUsedAt, undefined, "listing is not a use");
});

test("verify records the use, and it is the only thing that does", async () => {
  const created = JSON.parse(
    (
      await api.apiKeysHandler(
        postEvent({ orgId: ORG, keyId: "cms", name: "CMS", scopes: ["subscribers:read"] }),
      )
    ).body,
  ) as { plaintext: string };

  const before = (JSON.parse((await api.apiKeysHandler(getEvent())).body) as KeyView[]).find(
    (k) => k.keyId === "cms",
  );
  assert.equal(before?.lastUsedAt, undefined);

  const verified = await api.apiKeyVerifyHandler(postEvent({ orgId: ORG, key: created.plaintext }));
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.body.includes(created.plaintext), false, "verify echoed the key back");
  assert.equal(verified.body.includes("keyHash"), false);

  const after_ = (JSON.parse((await api.apiKeysHandler(getEvent())).body) as KeyView[]).find(
    (k) => k.keyId === "cms",
  );
  assert.ok(after_?.lastUsedAt, "verify is what makes Last used a fact");
  assert.ok(!Number.isNaN(Date.parse(after_.lastUsedAt)));
});

test("a bad key is a 400 with one sentence, whatever is wrong with it", async () => {
  // Unknown, and another org's live key, must be indistinguishable — otherwise
  // the endpoint confirms which guesses were once real values.
  const theirs = JSON.parse(
    (
      await api.apiKeysHandler(
        postEvent(
          { orgId: OTHER_ORG, keyId: "theirs", name: "Theirs", scopes: ["subscribers:read"] },
          "developer_admin",
          OTHER_ORG,
        ),
      )
    ).body,
  ) as { plaintext: string };

  const bodies: string[] = [];
  for (const key of ["ak_definitely-not-a-key", theirs.plaintext, ""]) {
    const res = await api.apiKeyVerifyHandler(postEvent({ orgId: ORG, key }));
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(key)}`);
    bodies.push(res.body);
  }
  assert.equal(new Set(bodies).size, 1, `distinguishable replies: ${bodies.join(" / ")}`);

  // ...and the other org's key was not touched by the attempt.
  const theirRows = JSON.parse(
    (await api.apiKeysHandler(getEvent("developer_admin", OTHER_ORG, OTHER_ORG))).body,
  ) as KeyView[];
  assert.equal(theirRows.find((k) => k.keyId === "theirs")?.lastUsedAt, undefined);
});

test("revoke keeps the row, and a second revoke says when it was already cut off", async () => {
  await api.apiKeysHandler(
    postEvent({ orgId: ORG, keyId: "to-revoke", name: "Doomed", scopes: ["campaigns:read"] }),
  );
  const first = await api.apiKeyRevokeHandler(postEvent({ orgId: ORG, keyId: "to-revoke" }));
  assert.equal(first.statusCode, 200);
  assert.equal((JSON.parse(first.body) as KeyView).revoked, true);

  const second = await api.apiKeyRevokeHandler(postEvent({ orgId: ORG, keyId: "to-revoke" }));
  assert.equal(second.statusCode, 400, "InvalidInputError → 400, not a 500 (#265)");
  assert.match(JSON.parse(second.body).error, /already revoked at/);

  // The row survives revocation — that is what makes it auditable.
  const rows = JSON.parse((await api.apiKeysHandler(getEvent())).body) as KeyView[];
  const row = rows.find((k) => k.keyId === "to-revoke");
  assert.equal(row?.revoked, true);
  assert.deepEqual(row?.scopes, ["campaigns:read"]);
});

test("a duplicate keyId is refused with the sentence, not a replaced credential", async () => {
  const res = await api.apiKeysHandler(
    postEvent({
      orgId: ORG,
      keyId: "billing-sync",
      name: "Something else",
      scopes: ["subscribers:read"],
    }),
  );
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /already exists/);
});

test("an unknown scope is refused at the boundary", async () => {
  const res = await api.apiKeysHandler(
    postEvent({ orgId: ORG, keyId: "bad-scope", name: "X", scopes: ["team:manage"] }),
  );
  // `team:manage` is a console capability, deliberately NOT an ApiKeyScope — a
  // key that could grant roles is not a least-privilege credential.
  assert.equal(res.statusCode, 400);
});

test("every route, read included, is apikeys:manage", async () => {
  // An analyst holds `reports:view` and nothing else. Every OTHER registry's GET
  // would answer them; this one must not — a key list is an inventory of machine
  // access, not a report.
  assert.equal((await api.apiKeysHandler(getEvent("analyst", ORG))).statusCode, 403);
  // An editor holds seven capabilities and none of them is this one.
  assert.equal((await api.apiKeysHandler(getEvent("editor", ORG))).statusCode, 403);
  assert.equal(
    (await api.apiKeysHandler(
      postEvent({ orgId: ORG, keyId: "nope", name: "N", scopes: ["campaigns:read"] }, "editor"),
    )).statusCode,
    403,
  );
  assert.equal(
    (await api.apiKeyRevokeHandler(postEvent({ orgId: ORG, keyId: "billing-sync" }, "editor")))
      .statusCode,
    403,
  );
  assert.equal(
    (await api.apiKeyVerifyHandler(postEvent({ orgId: ORG, key: "ak_x" }, "editor"))).statusCode,
    403,
  );
});

test("org scope is enforced, not just the role", async () => {
  // A developer_admin scoped to another org has the capability and not the org.
  assert.equal(
    (await api.apiKeysHandler(getEvent("developer_admin", OTHER_ORG, ORG))).statusCode,
    403,
  );
  assert.equal(
    (await api.apiKeysHandler(
      postEvent({ orgId: ORG, keyId: "x", name: "X", scopes: ["campaigns:read"] }, "developer_admin", OTHER_ORG),
    )).statusCode,
    403,
  );
});
