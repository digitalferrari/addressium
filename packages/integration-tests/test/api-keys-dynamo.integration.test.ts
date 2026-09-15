/**
 * `ApiKeyStore` against a REAL DynamoDB API (#280).
 *
 * STORE-PATTERN step 3 is explicit that memory tests do not establish DynamoDB
 * behavior, and this store is the one in the repo where that gap would bite
 * hardest. Its contract has a method none of the other registries have —
 * `findByHash`, an org-INDEPENDENT lookup — because a caller presenting a
 * credential is precisely the party that has not yet been placed in an org.
 *
 * `MemApiKeys` satisfies that with a second Map. The Dynamo adapter satisfies it
 * with a second ITEM (`APIKEYHASH#<digest>` in both key positions, holding a
 * pointer back to `(orgId, keyId)`), and the two halves have to stay in step:
 *
 *  - if `put` wrote only the registry row, verification would fail for a key
 *    that plainly exists — the console would show it and no integration could
 *    use it;
 *  - if `put` wrote a SNAPSHOT into the lookup rather than a pointer, a revoke
 *    would update one copy and leave the other authenticating. That is the
 *    failure with real consequences, and it is the one asserted below.
 *
 * Uses `dynalite` — the same pure-JS DynamoDB the rest of the integration suite
 * runs against — so PutItem, GetItem and the prefix Query are exercised for real
 * rather than stubbed. Deliberately its OWN file rather than an addition to
 * `dynamo.integration.test.ts`: the table it needs is the plain pk/sk one with no
 * index at all, which is itself part of the claim — the digest lookup adds no
 * GSI, so no CDK table change and no fixture change was needed to ship it.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
  DynamoDBClient,
  CreateTableCommand,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import { DynamoStores } from "@addressium/adapters-aws";
import {
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  authenticateApiKey,
  hashApiKey,
  InvalidInputError,
  type Clock,
} from "@addressium/domain";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium";
const ORG = "summit";
const OTHER_ORG = "northwind";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let endpoint: string;

class StepClock implements Clock {
  private t = Date.parse("2026-01-01T00:00:00.000Z");
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

const orgRecord = (orgId: string) => ({
  orgId,
  name: orgId,
  domains: ["example.com"],
  sesConfigSet: "cs",
  ipMode: "shared" as const,
  suppressionScope: "hybrid" as const,
  defaultTimezone: "UTC",
  setupComplete: true,
});

/**
 * `region` and `credentials` here are placeholders the SDK requires before it
 * will build a request at all; `endpoint` points at loopback dynalite, so
 * neither is sent anywhere or names a deployment target. Same shape as
 * `dynamo.integration.test.ts`.
 */
function connect(): DynamoStores {
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
  });
  return new DynamoStores(TABLE, client, { nonTransactionalCountersForTests: true });
}

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
  });
  // No GSI. The digest lookup rides the primary key, which is the whole reason
  // this shipped without touching the table definition in CDK.
  const input: CreateTableCommandInput = {
    TableName: TABLE,
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
  };
  await client.send(new CreateTableCommand(input));

  const stores = connect();
  await stores.organizations.put(orgRecord(ORG));
  await stores.organizations.put(orgRecord(OTHER_ORG));
});

after(() => {
  server?.close();
});

test("issue → list → verify → revoke, on DynamoDB", async () => {
  const stores = connect();
  const clock = new StepClock();

  const issued = await issueApiKey(stores, clock, {
    orgId: ORG,
    keyId: "billing-sync",
    name: "Billing entitlement sync",
    scopes: ["entitlement:write"],
  });

  // Stored under the org partition, with the digest and NOT the key.
  const stored = await stores.apiKeys.get(ORG, "billing-sync");
  assert.ok(stored);
  assert.equal(stored.keyHash, hashApiKey(issued.plaintext));
  assert.equal(JSON.stringify(stored).includes(issued.plaintext), false);

  // The prefix Query returns it, and only it.
  const listed = await listApiKeys(stores, ORG);
  assert.deepEqual(listed.map((k) => k.keyId), ["billing-sync"]);
  assert.equal(listed[0]?.lastUsedAt, undefined, "listing is not a use");

  // The second item resolves the digest with no org in hand — the method the
  // in-memory double cannot prove.
  const byHash = await stores.apiKeys.findByHash(hashApiKey(issued.plaintext));
  assert.equal(byHash?.keyId, "billing-sync");
  assert.equal(byHash?.orgId, ORG);

  // ...and the stamp survives the round trip through the real adapter.
  clock.advance(60_000);
  await authenticateApiKey(stores, clock, issued.plaintext);
  assert.equal(
    (await stores.apiKeys.get(ORG, "billing-sync"))?.lastUsedAt,
    "2026-01-01T00:01:00.000Z",
  );

  // THE ONE THAT MATTERS. Revoke writes through `put`, which rewrites both
  // items; if the lookup held a stale snapshot instead of a pointer, the key
  // would keep authenticating here while the console showed it revoked.
  clock.advance(1000);
  await revokeApiKey(stores, clock, ORG, "billing-sync");
  assert.equal((await stores.apiKeys.findByHash(hashApiKey(issued.plaintext)))?.revokedAt,
    "2026-01-01T00:01:01.000Z");
  await assert.rejects(
    () => authenticateApiKey(stores, clock, issued.plaintext),
    (e: unknown) => e instanceof InvalidInputError,
  );
  // The row is kept, which is what makes revocation auditable.
  assert.equal((await listApiKeys(stores, ORG)).length, 1);
  assert.equal((await listApiKeys(stores, ORG))[0]?.revoked, true);
});

test("the org partition really separates keys, and delete removes both items", async () => {
  const stores = connect();
  const clock = new StepClock();

  const mine = await issueApiKey(stores, clock, {
    orgId: ORG,
    keyId: "cms",
    name: "CMS integration",
    scopes: ["subscribers:read"],
  });
  const theirs = await issueApiKey(stores, clock, {
    orgId: OTHER_ORG,
    keyId: "cms",
    name: "Their CMS",
    scopes: ["subscribers:read"],
  });

  // Same keyId in two orgs: distinct rows, distinct secrets, and each digest
  // resolves to its own org rather than to whichever was written last.
  assert.notEqual(mine.plaintext, theirs.plaintext);
  assert.equal((await stores.apiKeys.findByHash(hashApiKey(mine.plaintext)))?.orgId, ORG);
  assert.equal((await stores.apiKeys.findByHash(hashApiKey(theirs.plaintext)))?.orgId, OTHER_ORG);

  // A key from another org is refused by the domain's org check — which lives
  // before the stamp, so nothing is written to the other tenant's record.
  await assert.rejects(
    () => authenticateApiKey(stores, clock, theirs.plaintext, { orgId: ORG }),
    (e: unknown) => e instanceof InvalidInputError,
  );
  assert.equal((await stores.apiKeys.get(OTHER_ORG, "cms"))?.lastUsedAt, undefined);

  // `delete` is the erasure path, not the console's Revoke. Both items go —
  // an orphaned lookup would outlive the key it points at.
  await stores.apiKeys.delete(ORG, "cms");
  assert.equal(await stores.apiKeys.get(ORG, "cms"), undefined);
  assert.equal(await stores.apiKeys.findByHash(hashApiKey(mine.plaintext)), undefined);
  // The other org is untouched.
  assert.equal((await stores.apiKeys.findByHash(hashApiKey(theirs.plaintext)))?.keyId, "cms");
});
