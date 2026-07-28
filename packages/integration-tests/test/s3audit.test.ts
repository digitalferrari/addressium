/**
 * Reading the WORM audit log (#191).
 *
 * The write side is trivial — one PutObject per entry. The read side is not,
 * because S3 lists ASCENDING and the question is always "what happened most
 * recently". Listing from the beginning of time and taking the tail would page
 * the entire history of a deployment to answer a question about yesterday, and
 * would get slower every day the product runs.
 *
 * So the reader walks day prefixes backwards and stops as soon as it has enough.
 * These assert that it does — including the call count, which is the whole point.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import type { AuditEntry } from "@addressium/core";
import { S3AuditLog } from "@addressium/adapters-aws";

const entry = (orgId: string | null, at: string, action: string): AuditEntry => ({
  orgId,
  memberSub: "cognito-sub-1",
  action,
  at,
});

/** An in-memory bucket that answers ListObjectsV2 and GetObject like S3 does. */
function fakeBucket(objects: Record<string, string> = {}) {
  const lists: string[] = [];
  const gets: string[] = [];
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "AKIAFAKE", secretAccessKey: "fake" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    if (name === "PutObjectCommand") {
      objects[cmd.input.Key as string] = String(cmd.input.Body);
      return {};
    }
    if (name === "ListObjectsV2Command") {
      const prefix = cmd.input.Prefix as string;
      lists.push(prefix);
      // S3 returns keys in ascending lexicographic order.
      const keys = Object.keys(objects).filter((k) => k.startsWith(prefix)).sort();
      return { Contents: keys.map((Key) => ({ Key })) };
    }
    if (name === "GetObjectCommand") {
      const key = cmd.input.Key as string;
      gets.push(key);
      const body = objects[key];
      if (body === undefined) throw new Error(`NoSuchKey: ${key}`);
      return { Body: { transformToString: async () => body } };
    }
    return {};
  };
  return { client, objects, lists, gets };
}

test("entries come back newest first", async () => {
  const fake = fakeBucket();
  const log = new S3AuditLog("audit-bucket", fake.client);
  for (const [at, action] of [
    ["2026-07-26T09:00:00.000Z", "team.invite"],
    ["2026-07-28T11:00:00.000Z", "subscribers.export"],
    ["2026-07-28T08:00:00.000Z", "privacy.erase"],
  ] as const) {
    await log.append(entry("summit", at, action));
  }

  const read = await log.read("summit", { to: "2026-07-28T23:59:59.000Z" });
  assert.deepEqual(read.map((e) => e.action), [
    "subscribers.export",
    "privacy.erase",
    "team.invite",
  ]);
});

test("a recent page costs a handful of list calls, not one per day of history", async () => {
  // This is the reason the reader walks backwards at all. With a year of
  // history behind it, "show me the last 5 actions" must not touch the year.
  const fake = fakeBucket();
  const log = new S3AuditLog("audit-bucket", fake.client);
  for (let d = 1; d <= 28; d++) {
    const day = String(d).padStart(2, "0");
    await log.append(entry("summit", `2026-07-${day}T12:00:00.000Z`, `action-${day}`));
  }

  const read = await log.read("summit", { to: "2026-07-28T23:59:59.000Z", limit: 3 });
  assert.deepEqual(read.map((e) => e.action), ["action-28", "action-27", "action-26"]);
  assert.ok(fake.lists.length <= 4, `walked ${fake.lists.length} days for 3 entries`);
  // And it does not fetch objects it is going to discard.
  assert.equal(fake.gets.length, 3);
});

test("the scope is the key prefix — one org never reads another's", async () => {
  const fake = fakeBucket();
  const log = new S3AuditLog("audit-bucket", fake.client);
  await log.append(entry("summit", "2026-07-28T10:00:00.000Z", "team.invite"));
  await log.append(entry("ledger", "2026-07-28T10:00:00.000Z", "team.invite"));
  await log.append(entry(null, "2026-07-28T10:00:00.000Z", "orgs.create"));

  const to = "2026-07-28T23:59:59.000Z";
  assert.equal((await log.read("summit", { to })).length, 1);
  assert.equal((await log.read("ledger", { to })).length, 1);
  // orgId null writes under GLOBAL — a scope of its own, NOT "every org".
  assert.deepEqual((await log.read(null, { to })).map((e) => e.action), ["orgs.create"]);
  assert.ok(fake.lists.every((p) => p.startsWith("audit/")));
});

test("the default window is bounded, so an empty log terminates", async () => {
  // Without a floor, reading an empty scope would walk back one day at a time
  // toward 1970 — a request that never returns.
  const fake = fakeBucket();
  const log = new S3AuditLog("audit-bucket", fake.client);
  assert.deepEqual(await log.read("summit", { to: "2026-07-28T00:00:00.000Z" }), []);
  assert.ok(fake.lists.length <= 92, `walked ${fake.lists.length} days on an empty log`);
});

test("one corrupt object does not blank the view", async () => {
  // The point of the log is that the rest of it is still evidence. A single
  // unparseable object must cost one row, not the whole page.
  const fake = fakeBucket();
  const log = new S3AuditLog("audit-bucket", fake.client);
  await log.append(entry("summit", "2026-07-28T10:00:00.000Z", "team.invite"));
  await log.append(entry("summit", "2026-07-28T11:00:00.000Z", "privacy.erase"));
  const victim = Object.keys(fake.objects).find((k) => fake.objects[k]!.includes("team.invite"))!;
  fake.objects[victim] = "{ not json";

  const read = await log.read("summit", { to: "2026-07-28T23:59:59.000Z" });
  assert.deepEqual(read.map((e) => e.action), ["privacy.erase"]);
});

test("the limit is capped, so a caller cannot ask for the whole bucket", async () => {
  const fake = fakeBucket();
  const log = new S3AuditLog("audit-bucket", fake.client);
  for (let i = 0; i < 12; i++) {
    await log.append(entry("summit", `2026-07-28T10:00:${String(i).padStart(2, "0")}.000Z`, `a${i}`));
  }
  const read = await log.read("summit", { to: "2026-07-28T23:59:59.000Z", limit: 100_000 });
  assert.equal(read.length, 12, "everything that exists, but the cap still applies above it");
  assert.equal((await log.read("summit", { to: "2026-07-28T23:59:59.000Z", limit: 5 })).length, 5);
});
