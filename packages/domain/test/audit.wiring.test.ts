/**
 * Audit log wiring (#191).
 *
 * The WORM bucket has been provisioned, alarmed and — since #219 — correctly
 * moded, and nothing had ever written an object to it. `recordAudit` had zero
 * non-test callers, so every "sensitive actions are audited" claim in the docs
 * rested on a function nobody called.
 *
 * These cover the properties the sink itself must have. The API-layer call sites
 * are asserted by the handler tests; what matters here is that an entry is
 * complete, timestamped from the injected clock, and that a failing sink cannot
 * take the product down with it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEntry } from "@addressium/core";
import { MemAuditLog, recordAudit, type AuditLog, type Clock } from "@addressium/domain";

const NOW = "2026-07-28T12:00:00.000Z";
const clock: Clock = { now: () => new Date(NOW) };

test("an entry carries who, what, which org and when", async () => {
  const log = new MemAuditLog();
  const entry = await recordAudit(log, clock, {
    orgId: "summit",
    memberSub: "cognito-sub-1",
    action: "team.invite",
    target: "new@example.com as editor",
  });

  assert.deepEqual(entry, {
    orgId: "summit",
    memberSub: "cognito-sub-1",
    action: "team.invite",
    target: "new@example.com as editor",
    at: NOW,
  });
  assert.deepEqual(log.entries, [entry]);
});

test("the timestamp comes from the injected clock, not wall time", async () => {
  // Deterministic under test, and it means the entry's time is the action's
  // time rather than whenever the write happened to flush.
  const log = new MemAuditLog();
  const e = await recordAudit(log, clock, { orgId: null, memberSub: "s", action: "orgs.create" });
  assert.equal(e.at, NOW);
});

test("a cross-org action records orgId null rather than inventing a scope", async () => {
  const log = new MemAuditLog();
  const e = await recordAudit(log, clock, { orgId: null, memberSub: "s", action: "orgs.create" });
  assert.equal(e.orgId, null);
});

test("entries accumulate in order — an audit log is append-only", async () => {
  const log = new MemAuditLog();
  for (const action of ["privacy.export", "privacy.erase", "subscribers.export"]) {
    await recordAudit(log, clock, { orgId: "summit", memberSub: "s", action });
  }
  assert.deepEqual(log.entries.map((e) => e.action), [
    "privacy.export",
    "privacy.erase",
    "subscribers.export",
  ]);
});

test("a failing sink surfaces to the caller, which is what lets the API decide", async () => {
  // recordAudit does NOT swallow: the API layer catches and logs, because an
  // audit write that fails must not roll back an action the operator already
  // completed. Burying it here would remove that choice.
  const failing: AuditLog = {
    async append(): Promise<void> {
      throw new Error("bucket unreachable");
    },
  };
  await assert.rejects(
    () => recordAudit(failing, clock, { orgId: "summit", memberSub: "s", action: "team.invite" }),
    /bucket unreachable/,
  );
});

test("target is optional — some actions have no single subject", async () => {
  const log = new MemAuditLog();
  const e = await recordAudit(log, clock, { orgId: "summit", memberSub: "s", action: "alerts.update" });
  assert.equal((e as AuditEntry).target, undefined);
});

/**
 * The read side (#191).
 *
 * The bucket was provisioned, then the writes were wired, and the only way to
 * see an entry was still an AWS console login — the dependency §4.19 exists to
 * remove. These pin the contract the S3 reader has to satisfy: newest first,
 * one scope at a time, and bounded.
 */
const at = (iso: string): AuditEntry => ({
  orgId: "summit",
  memberSub: "s",
  action: "subscribers.export",
  at: iso,
});

test("entries come back newest first — an audit view is read from the top", async () => {
  const log = new MemAuditLog();
  for (const d of ["2026-07-01", "2026-07-28", "2026-07-14"]) {
    await log.append(at(`${d}T00:00:00.000Z`));
  }
  const read = await log.read("summit");
  assert.deepEqual(read.map((e) => e.at.slice(0, 10)), ["2026-07-28", "2026-07-14", "2026-07-01"]);
});

test("a scope reads only its own entries — GLOBAL is not 'all orgs'", async () => {
  // An entry belongs to exactly one scope. Merging them would let an operator
  // scoped to one org read deployment-wide actions, which is the opposite of
  // what org scoping is for.
  const log = new MemAuditLog();
  await log.append({ orgId: "summit", memberSub: "s", action: "team.invite", at: NOW });
  await log.append({ orgId: "ledger", memberSub: "s", action: "team.invite", at: NOW });
  await log.append({ orgId: null, memberSub: "s", action: "orgs.create", at: NOW });

  assert.deepEqual((await log.read("summit")).map((e) => e.action), ["team.invite"]);
  assert.deepEqual((await log.read(null)).map((e) => e.action), ["orgs.create"]);
  assert.deepEqual(await log.read("nobody"), []);
});

test("the window and the limit both bound the read", async () => {
  // Unbounded is not an option: a deployment that has run for a year would page
  // its entire history to answer a question about yesterday.
  const log = new MemAuditLog();
  for (let d = 1; d <= 10; d++) {
    await log.append(at(`2026-07-${String(d).padStart(2, "0")}T00:00:00.000Z`));
  }
  assert.equal((await log.read("summit", { limit: 3 })).length, 3);
  const windowed = await log.read("summit", {
    from: "2026-07-04T00:00:00.000Z",
    to: "2026-07-06T00:00:00.000Z",
  });
  assert.deepEqual(windowed.map((e) => e.at.slice(8, 10)), ["06", "05", "04"]);
});
