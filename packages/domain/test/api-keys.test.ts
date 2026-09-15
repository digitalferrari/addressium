/**
 * API keys (#280) — the three properties that make this a credential rather
 * than a row with a secret-looking string in it.
 *
 *  1. THE PLAINTEXT IS NEVER STORED. It appears in exactly one return value,
 *     once, and nothing persisted or subsequently returned contains it.
 *  2. A REVOKED KEY DOES NOT AUTHENTICATE, and revoking keeps the record so the
 *     operator can still see what the credential could do and when it was cut.
 *  3. "LAST USED" IS EARNED. `authenticateApiKey` is the only writer of
 *     `lastUsedAt`; listing, issuing and revoking leave it exactly as it was.
 *
 * (3) is the one with history behind it. A screen that renders a plausible
 * timestamp no backend produces is worse than an honest empty state — it looks
 * confirmed. So the tests below do not merely check that the field can be set;
 * they check that every OTHER operation leaves it alone, which is what would
 * break first if someone later stamped it from the list handler for convenience.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  memStores,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  authenticateApiKey,
  hashApiKey,
  InvalidInputError,
  type Clock,
  type Stores,
} from "@addressium/domain";

const ORG = "summit";
const OTHER_ORG = "northwind";

/** A clock the test drives, so "last used" is checked as a value rather than a race. */
class StepClock implements Clock {
  private t: number;
  constructor(iso: string) {
    this.t = Date.parse(iso);
  }
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

async function withOrgs(): Promise<Stores> {
  const stores = memStores();
  await stores.organizations.put(orgRecord(ORG));
  await stores.organizations.put(orgRecord(OTHER_ORG));
  return stores;
}

const input = {
  orgId: ORG,
  keyId: "billing-sync",
  name: "Billing entitlement sync",
  scopes: ["entitlement:write" as const],
};

test("the plaintext is returned once and never stored", async () => {
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  const issued = await issueApiKey(stores, clock, input);

  assert.match(issued.plaintext, /^ak_[A-Za-z0-9_-]{20,}$/);

  // Nothing persisted contains the plaintext, and what IS persisted is its
  // digest. Serializing the whole record is the point: a future field that
  // accidentally carried the key would fail here rather than in production.
  const stored = await stores.apiKeys.get(ORG, input.keyId);
  assert.ok(stored);
  assert.equal(JSON.stringify(stored).includes(issued.plaintext), false);
  assert.equal(stored.keyHash, hashApiKey(issued.plaintext));

  // And no later read hands it back — not the list, and not the view returned
  // alongside it at creation.
  const listed = await listApiKeys(stores, ORG);
  assert.equal(JSON.stringify(listed).includes(issued.plaintext), false);
  assert.equal(JSON.stringify(issued.key).includes(issued.plaintext), false);
});

test("no response carries the digest either", async () => {
  // The hash cannot be reversed, but it IS the value `findByHash` accepts — so
  // handing it to a screen would be handing out a working lookup token.
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  const issued = await issueApiKey(stores, clock, input);
  const hash = hashApiKey(issued.plaintext);

  assert.equal(JSON.stringify(issued.key).includes(hash), false);
  assert.equal(JSON.stringify(await listApiKeys(stores, ORG)).includes(hash), false);
  assert.equal(
    JSON.stringify(await authenticateApiKey(stores, clock, issued.plaintext)).includes(hash),
    false,
  );
});

test("displayPrefix is a prefix of the real key, and far too short to search", async () => {
  const stores = await withOrgs();
  const issued = await issueApiKey(stores, new StepClock("2026-01-01T00:00:00.000Z"), input);
  assert.ok(issued.plaintext.startsWith(issued.key.displayPrefix));
  assert.ok(issued.key.displayPrefix.length < issued.plaintext.length / 2);
});

test("lastUsedAt is absent until the key is actually presented", async () => {
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  const issued = await issueApiKey(stores, clock, input);

  // Issuance does not count as a use.
  assert.equal(issued.key.lastUsedAt, undefined);

  // Neither does listing — the failure this guards is a console that stamps the
  // column simply by being opened, which would make "last used" a record of an
  // operator's browsing.
  await listApiKeys(stores, ORG);
  await listApiKeys(stores, ORG);
  assert.equal((await listApiKeys(stores, ORG))[0]?.lastUsedAt, undefined);
  assert.equal((await stores.apiKeys.get(ORG, input.keyId))?.lastUsedAt, undefined);

  clock.advance(60_000);
  const verified = await authenticateApiKey(stores, clock, issued.plaintext);
  assert.equal(verified.lastUsedAt, "2026-01-01T00:01:00.000Z");
  // ...and it is durable, not just in the return value.
  assert.equal((await listApiKeys(stores, ORG))[0]?.lastUsedAt, "2026-01-01T00:01:00.000Z");

  // A later use moves it forward.
  clock.advance(3_600_000);
  await authenticateApiKey(stores, clock, issued.plaintext);
  assert.equal((await listApiKeys(stores, ORG))[0]?.lastUsedAt, "2026-01-01T01:01:00.000Z");
});

test("a revoked key stops authenticating but keeps its record", async () => {
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  const issued = await issueApiKey(stores, clock, input);
  await authenticateApiKey(stores, clock, issued.plaintext);

  clock.advance(1000);
  const revoked = await revokeApiKey(stores, clock, ORG, input.keyId);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.revokedAt, "2026-01-01T00:00:01.000Z");

  await assert.rejects(
    () => authenticateApiKey(stores, clock, issued.plaintext),
    (e: unknown) => e instanceof InvalidInputError && /invalid API key/.test((e as Error).message),
  );

  // The row survives — "what could this credential do, and when did we cut it
  // off" is the question after an incident, and a deleted row answers neither.
  const listed = await listApiKeys(stores, ORG);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.revoked, true);
  assert.deepEqual(listed[0]?.scopes, ["entitlement:write"]);
  assert.equal(listed[0]?.lastUsedAt, "2026-01-01T00:00:00.000Z");
});

test("a rejected verification does not stamp lastUsedAt", async () => {
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  const issued = await issueApiKey(stores, clock, {
    ...input,
    scopes: ["subscribers:read"],
  });

  clock.advance(5000);
  // Wrong scope: a valid credential making an invalid call. Recording a use
  // would overstate what the key has done.
  await assert.rejects(() =>
    authenticateApiKey(stores, clock, issued.plaintext, { requiredScope: "entitlement:write" }),
  );
  assert.equal((await listApiKeys(stores, ORG))[0]?.lastUsedAt, undefined);

  // The scope it does hold works, and stamps.
  await authenticateApiKey(stores, clock, issued.plaintext, { requiredScope: "subscribers:read" });
  assert.equal((await listApiKeys(stores, ORG))[0]?.lastUsedAt, "2026-01-01T00:00:05.000Z");
});

test("a key from another org is refused without being touched", async () => {
  // The org check lives INSIDE authenticateApiKey, before the stamp. A
  // handler-side comparison would run after another tenant's credential had
  // already been written to and disclosed.
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  const theirs = await issueApiKey(stores, clock, { ...input, orgId: OTHER_ORG });

  clock.advance(1000);
  await assert.rejects(
    () => authenticateApiKey(stores, clock, theirs.plaintext, { orgId: ORG }),
    (e: unknown) => e instanceof InvalidInputError && /invalid API key/.test((e as Error).message),
  );
  assert.equal((await listApiKeys(stores, OTHER_ORG))[0]?.lastUsedAt, undefined);
});

test("an unknown key is refused with the same sentence as a revoked one", async () => {
  // Distinguishing the two would confirm to a guesser that a particular value
  // was once real.
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  const issued = await issueApiKey(stores, clock, input);
  await revokeApiKey(stores, clock, ORG, input.keyId);

  const messages: string[] = [];
  for (const candidate of [issued.plaintext, "ak_not-a-real-key", ""]) {
    await assert.rejects(
      () => authenticateApiKey(stores, clock, candidate),
      (e: unknown) => {
        messages.push((e as Error).message);
        return e instanceof InvalidInputError;
      },
    );
  }
  assert.equal(new Set(messages).size, 1, `distinguishable failures: ${messages.join(" / ")}`);
});

test("issuing over an existing keyId is refused rather than replacing the credential", async () => {
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  const first = await issueApiKey(stores, clock, input);

  await assert.rejects(
    () => issueApiKey(stores, clock, { ...input, name: "Something else" }),
    (e: unknown) => e instanceof InvalidInputError && /already exists/.test((e as Error).message),
  );

  // The original still works — a silent replacement would have broken a running
  // integration while reporting success.
  const verified = await authenticateApiKey(stores, clock, first.plaintext);
  assert.equal(verified.name, input.name);
  assert.equal((await listApiKeys(stores, ORG)).length, 1);
});

test("issuing for an unknown org is a caller error, not a 500", async () => {
  const stores = await withOrgs();
  await assert.rejects(
    () => issueApiKey(stores, new StepClock("2026-01-01T00:00:00.000Z"), { ...input, orgId: "nope" }),
    (e: unknown) => e instanceof InvalidInputError && /unknown org/.test((e as Error).message),
  );
});

test("revoking twice tells the operator when it was already cut off", async () => {
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  await issueApiKey(stores, clock, input);
  await revokeApiKey(stores, clock, ORG, input.keyId);

  await assert.rejects(
    () => revokeApiKey(stores, clock, ORG, input.keyId),
    (e: unknown) =>
      e instanceof InvalidInputError && /already revoked at 2026-01-01T00:00:00/.test((e as Error).message),
  );
  await assert.rejects(
    () => revokeApiKey(stores, clock, ORG, "never-existed"),
    (e: unknown) => e instanceof InvalidInputError && /unknown API key/.test((e as Error).message),
  );
});

test("keys are org-scoped in both directions", async () => {
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  await issueApiKey(stores, clock, input);
  await issueApiKey(stores, clock, { ...input, orgId: OTHER_ORG, keyId: "cms" });

  assert.deepEqual((await listApiKeys(stores, ORG)).map((k) => k.keyId), ["billing-sync"]);
  assert.deepEqual((await listApiKeys(stores, OTHER_ORG)).map((k) => k.keyId), ["cms"]);
});

test("two keys issued back to back get different plaintexts and different digests", async () => {
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  const a = await issueApiKey(stores, clock, input);
  const b = await issueApiKey(stores, clock, { ...input, keyId: "cms" });
  assert.notEqual(a.plaintext, b.plaintext);
  assert.notEqual(
    (await stores.apiKeys.get(ORG, "billing-sync"))?.keyHash,
    (await stores.apiKeys.get(ORG, "cms"))?.keyHash,
  );
  // Each resolves to its own record rather than the other's.
  assert.equal((await authenticateApiKey(stores, clock, a.plaintext)).keyId, "billing-sync");
  assert.equal((await authenticateApiKey(stores, clock, b.plaintext)).keyId, "cms");
});

test("the list is newest first, so a key just issued is at the top", async () => {
  const stores = await withOrgs();
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  await issueApiKey(stores, clock, input);
  clock.advance(1000);
  await issueApiKey(stores, clock, { ...input, keyId: "cms" });
  assert.deepEqual((await listApiKeys(stores, ORG)).map((k) => k.keyId), ["cms", "billing-sync"]);
});

test("a duplicated scope is named rather than silently collapsed", async () => {
  const stores = await withOrgs();
  await assert.rejects(
    () =>
      issueApiKey(stores, new StepClock("2026-01-01T00:00:00.000Z"), {
        ...input,
        scopes: ["subscribers:read", "subscribers:read"],
      }),
    (e: unknown) => e instanceof InvalidInputError && /listed twice/.test((e as Error).message),
  );
});
