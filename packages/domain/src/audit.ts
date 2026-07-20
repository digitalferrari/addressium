/**
 * Audit log (docs/ARCHITECTURE.md §4.19, docs/SECURITY.md §4.3, #29).
 *
 * Every privileged admin action appends an AuditEntry. In production the sink is
 * an S3 bucket with Object Lock (WORM) so history can't be rewritten even by an
 * admin; the AuditLog port keeps that a side channel (not a queryable Store) and
 * lets tests capture entries in memory. `recordAudit` stamps the timestamp from
 * the injected clock so the entry is deterministic under test.
 */
import type { AuditEntry } from "@addressium/core";
import type { Clock } from "./ports.js";

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
}

export async function recordAudit(
  log: AuditLog,
  clock: Clock,
  entry: Omit<AuditEntry, "at">,
): Promise<AuditEntry> {
  const full: AuditEntry = { ...entry, at: clock.now().toISOString() };
  await log.append(full);
  return full;
}

/** In-memory audit sink for tests. */
export class MemAuditLog implements AuditLog {
  public entries: AuditEntry[] = [];
  async append(entry: AuditEntry) {
    this.entries.push(entry);
  }
}
