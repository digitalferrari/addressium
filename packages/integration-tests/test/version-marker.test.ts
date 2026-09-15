/**
 * Deployed-version marker (#213).
 *
 * This is deliberately small, but it is load-bearing: the migration runner reads
 * this marker to decide which migrations are pending, and the upgrade rehearsal
 * asserts on `GET /version` before and after a deploy to prove the loop works.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { memStores } from "@addressium/domain";
import { APP_VERSION, EXPECTED_SCHEMA_VERSION, VERSION_ITEM } from "@addressium/core";
import { applyMigrations, type Migration } from "@addressium/svc-api";

test("a fresh install reports no deployed version", async () => {
  const s = memStores();
  assert.equal(await s.version.get(), undefined);
});

test("the marker round-trips and is overwritten by a later deploy", async () => {
  const s = memStores();
  await s.version.put({ version: "0.1.0", schemaVersion: 1, deployedAt: "2026-07-28T00:00:00.000Z" });
  assert.equal((await s.version.get())?.version, "0.1.0");

  // An upgrade replaces the marker rather than appending — there is exactly one.
  await s.version.put({ version: "0.1.1", schemaVersion: 1, deployedAt: "2026-07-29T00:00:00.000Z" });
  const v = await s.version.get();
  assert.equal(v?.version, "0.1.1");
  assert.equal(v?.schemaVersion, 1);
});

test("schema version is tracked separately from app version", async () => {
  // A code release must be able to ship without touching data shape; only a
  // migration may advance schemaVersion. Conflating them would force a
  // migration on every release.
  const s = memStores();
  await s.version.put({ version: "0.2.0", schemaVersion: 1, deployedAt: "2026-08-01T00:00:00.000Z" });
  assert.equal((await s.version.get())?.schemaVersion, EXPECTED_SCHEMA_VERSION);
});

test("the marker is a singleton outside any org partition", () => {
  // It describes the installation, not a tenant — so it must not be org-scoped,
  // or a multi-org install would have conflicting answers to "what version?".
  assert.equal(VERSION_ITEM.pk, "SCHEMA");
  assert.equal(VERSION_ITEM.sk, "VERSION");
  assert.ok(!VERSION_ITEM.pk.startsWith("ORG#"));
});

test("APP_VERSION is a parseable semver", () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});

test("an upgrade runs each missing migration in order and refuses a gap", async () => {
  const calls: number[] = [];
  const client = { send: async () => ({}) };
  const migrations: Migration[] = [
    { toVersion: 2, apply: async () => { calls.push(2); } },
    { toVersion: 3, apply: async () => { calls.push(3); } },
  ];
  await applyMigrations(client, { version: "0.1.0", schemaVersion: 1, deployedAt: "2026-09-01T00:00:00.000Z" }, 3, migrations);
  assert.deepEqual(calls, [2, 3]);
  await assert.rejects(
    () => applyMigrations(client, { version: "0.1.0", schemaVersion: 1, deployedAt: "2026-09-01T00:00:00.000Z" }, 3, [migrations[0]!]),
    /missing migration to schema 3/,
  );
});

test("a downgrade is refused before it can reinterpret stored data", async () => {
  const client = { send: async () => ({}) };
  await assert.rejects(
    () => applyMigrations(client, { version: "0.2.0", schemaVersion: 2, deployedAt: "2026-09-01T00:00:00.000Z" }, 1),
    /refusing to deploy schema 1 over newer installed schema 2/,
  );
});
