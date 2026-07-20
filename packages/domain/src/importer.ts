/**
 * CSV / Pinpoint-export importer (docs/ARCHITECTURE.md §4.7).
 *
 * Parses a CSV (header row + rows), maps `email` + attribute columns to
 * subscribers, dedupes, skips suppressed addresses, and creates/updates the
 * subscriber + a subscription on the target list. `dryRun` reports counts
 * without writing.
 */
import { randomUUID } from "node:crypto";
import type { Subscriber, Subscription, SubscriptionStatus } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export interface ImportOptions {
  orgId: string;
  listId: string;
  csv: string;
  /** Subscription status for imported rows (existing subscribers → confirmed). */
  status?: Extract<SubscriptionStatus, "confirmed" | "pending">;
  dryRun?: boolean;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0] ?? "").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}

export async function importCsvSubscribers(
  stores: Stores,
  clock: Clock,
  opts: ImportOptions,
): Promise<ImportReport> {
  const rows = parseCsv(opts.csv);
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, errors: [] };
  const seen = new Set<string>();
  const now = clock.now().toISOString();

  for (const row of rows) {
    const email = (row["email"] ?? "").trim().toLowerCase();
    if (!email.includes("@")) {
      report.errors.push(`invalid email in row: ${JSON.stringify(row)}`);
      continue;
    }
    if (seen.has(email)) {
      report.skipped++;
      continue;
    }
    seen.add(email);
    if (await stores.suppression.isSuppressed(opts.orgId, email)) {
      report.skipped++;
      continue;
    }

    const { email: _drop, ...attributes } = row;
    const existing = await stores.subscribers.findByEmail(opts.orgId, email);

    if (opts.dryRun) {
      existing ? report.updated++ : report.created++;
      continue;
    }

    let subscriber: Subscriber;
    if (existing) {
      subscriber = { ...existing, attributes: { ...existing.attributes, ...attributes } };
      await stores.subscribers.put(subscriber);
      report.updated++;
    } else {
      subscriber = {
        orgId: opts.orgId,
        sub: randomUUID(),
        email,
        attributes,
        source: "import",
        status: "active",
        entitlement: "free",
      };
      await stores.subscribers.put(subscriber);
      report.created++;
    }
    const subscription: Subscription = {
      orgId: opts.orgId,
      subscriberId: subscriber.sub,
      listId: opts.listId,
      status: opts.status ?? "confirmed",
      updatedAt: now,
    };
    await stores.subscriptions.put(subscription);
  }
  return report;
}
