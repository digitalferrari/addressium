/**
 * Audit log: recordAudit stamps the clock's timestamp and appends the entry to
 * the sink (WORM S3 in prod; in-memory here).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recordAudit, MemAuditLog } from "@addressium/domain";

class FixedClock {
  now() {
    return new Date("2026-07-20T12:00:00.000Z");
  }
}

test("recordAudit stamps the timestamp and appends to the log", async () => {
  const log = new MemAuditLog();
  const entry = await recordAudit(log, new FixedClock(), {
    orgId: "summit",
    memberSub: "admin-1",
    action: "list.close",
    target: "ledger",
  });
  assert.equal(entry.at, "2026-07-20T12:00:00.000Z");
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0]?.action, "list.close");
  assert.equal(log.entries[0]?.memberSub, "admin-1");
});

test("cross-org (null orgId) entries are supported", async () => {
  const log = new MemAuditLog();
  const entry = await recordAudit(log, new FixedClock(), {
    orgId: null,
    memberSub: "admin-1",
    action: "org.provision",
    target: "lakeside-ledger",
  });
  assert.equal(entry.orgId, null);
  assert.equal(log.entries[0]?.action, "org.provision");
});
