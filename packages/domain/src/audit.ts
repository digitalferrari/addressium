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

/**
 * The read side (#191).
 *
 * Deliberately a separate port from `AuditLog`. Every service writes; only the
 * admin console reads, and giving the send pipeline a `read` method it never
 * calls would mean granting it `s3:GetObject` on the audit bucket for nothing.
 * Two ports keep the IAM grants honest.
 *
 * An audit log nobody can read is a compliance artifact, not a control: "who
 * exported subscriber data on the 14th?" is the question the WORM bucket exists
 * to answer, and until it can be asked from the console the answer lives in the
 * AWS console — which is precisely the dependency §4.19 exists to remove.
 */
export interface AuditReader {
  /**
   * Newest first. `orgId: null` reads the cross-org scope (org creation, pool
   * linking) rather than "all orgs" — an entry belongs to exactly one scope, and
   * conflating them would let an org-scoped operator see deployment-wide actions.
   */
  read(
    orgId: string | null,
    opts?: { from?: string; to?: string; limit?: number },
  ): Promise<AuditEntry[]>;
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

/** In-memory audit sink for tests. Reads back what it was given, newest first. */
export class MemAuditLog implements AuditLog, AuditReader {
  public entries: AuditEntry[] = [];
  async append(entry: AuditEntry) {
    this.entries.push(entry);
  }
  async read(
    orgId: string | null,
    opts: { from?: string; to?: string; limit?: number } = {},
  ): Promise<AuditEntry[]> {
    return this.entries
      .filter((e) => (e.orgId ?? null) === orgId)
      .filter((e) => (opts.from ? e.at >= opts.from : true))
      .filter((e) => (opts.to ? e.at <= opts.to : true))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, opts.limit ?? 100);
  }
}
