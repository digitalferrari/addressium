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
