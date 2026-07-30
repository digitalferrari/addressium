/**
 * Importing a provider's account suppression list (docs/ARCHITECTURE.md §4.7,
 * §4.13, #240).
 *
 * This is the half of a Pinpoint migration that nothing else can reconstruct.
 * Subscriber records can be re-exported from the source at any time; the
 * knowledge that an address hard-bounced two years ago exists only in the
 * account suppression list. Import the endpoints without it and the first
 * campaign mails every one of them again — straight into the bounce and
 * complaint rates the deliverability halt (#217) exists to catch. The migration
 * becomes the reputation event it was supposed to avoid, and it does so on day
 * one, in front of somebody deciding whether to trust this.
 *
 * Which is why the ORDER matters and is asserted rather than assumed: an
 * operator must land suppressions before, or with, their subscribers. See
 * `importSuppressionList`'s return value — it reports what it wrote so the
 * console can refuse to run a subscriber import that has no suppression run
 * behind it.
 */
import type { SuppressionEntry, SuppressionScope, SuppressionSource } from "@addressium/core";
import type { Clock, Stores, SuppressedDestination, SuppressionListReader } from "./ports.js";

/**
 * How many entries to accumulate before writing (#240).
 *
 * DynamoDB's own batch limit is 25, and `addMany` chunks to it — this is the
 * larger buffer the STREAM is drained into, so one slow page does not become one
 * write per address. Bounded because the whole point of the async iterable is
 * that the list never has to be resident.
 */
const WRITE_BATCH = 500;

/**
 * SES's suppression reason -> what it means to us.
 *
 * Both map to `global` scope, matching how a live bounce or complaint is
 * recorded (`suppress.ts`): these threaten the sending reputation that every org
 * in the deployment shares, so scoping them per-org would let a second org mail
 * an address the account already knows is toxic (§4.13).
 *
 * Deliberately a lookup with no default. SES can add reasons, and a reason we do
 * not recognize must NOT be silently coerced into "bounce" — that would invent a
 * permanent global suppression from a value nobody has read. Unrecognized entries
 * are reported, not guessed.
 */
const REASON_MAP: Record<string, { source: SuppressionSource; scope: SuppressionScope }> = {
  BOUNCE: { source: "bounce", scope: "global" },
  COMPLAINT: { source: "complaint", scope: "global" },
};

export interface SuppressionImportOptions {
  orgId: string;
  /**
   * Report what would be written without writing it.
   *
   * Worth having on this path specifically: the entries are GLOBAL and there is
   * no bulk un-suppress, so an operator who points this at the wrong account has
   * no cheap way back. A dry run is the difference between a mistake and an
   * incident.
   */
  dryRun?: boolean;
}

export interface SuppressionImportReport {
  /** Entries the provider returned. */
  read: number;
  /** Entries written (or that would be, on a dry run). */
  written: number;
  /** Per-source counts of what was written. */
  bySource: Record<string, number>;
  /**
   * Entries whose reason we do not map, as `email: reason` — never written.
   * Surfaced rather than counted so an operator can act on them, because the
   * alternative reading of "3 skipped" is "3 addresses we will now mail".
   */
  unmapped: { email: string; reason: string }[];
  /** Entries with no usable email address. */
  malformed: number;
}

/**
 * Basic sanity on an address before it becomes a global suppression key.
 *
 * Not full validation — a suppression is a REFUSAL to send, so a false positive
 * costs one address that was never going to deliver, while a false negative
 * writes junk into the partition every send path reads. So the bar is only:
 * non-empty, one `@`, no whitespace.
 */
const usableEmail = (s: string): boolean =>
  s.length > 0 && s.split("@").length === 2 && !/\s/.test(s) && !s.startsWith("@") && !s.endsWith("@");

/**
 * Import every suppressed destination the reader yields (#240).
 *
 * Streams the provider's list and writes in batches — never one call per
 * address, which for a real account list is slow enough that an operator
 * abandons it half-finished, and half-finished is the dangerous state: their
 * subscribers are imported and only some of their suppressions are.
 *
 * `addedAt` is the provider's own timestamp when it gave one, not the import
 * time. It is consent-adjacent evidence: when the operator later asks why an
 * address is suppressed, "SES recorded a hard bounce in 2023" is the answer, and
 * stamping it with today's date destroys exactly that. Falls back to now only
 * when the provider is silent.
 */
export async function importSuppressionList(
  stores: Stores,
  clock: Clock,
  reader: SuppressionListReader,
  opts: SuppressionImportOptions,
): Promise<SuppressionImportReport> {
  const now = clock.now().toISOString();
  const report: SuppressionImportReport = {
    read: 0,
    written: 0,
    bySource: {},
    unmapped: [],
    malformed: 0,
  };
  let batch: SuppressionEntry[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    if (!opts.dryRun) await stores.suppression.addMany(batch);
    report.written += batch.length;
    batch = [];
  };

  for await (const d of reader.list()) {
    report.read++;
    const entry = toEntry(d, opts.orgId, now);
    if (entry === "malformed") {
      report.malformed++;
      continue;
    }
    if (entry === "unmapped") {
      // Capped so a provider that starts returning an unmapped reason for a
      // whole list cannot turn this report into the thing that runs the Lambda
      // out of memory. The count in `read` still tells the true story.
      if (report.unmapped.length < 100) {
        report.unmapped.push({ email: d.email, reason: d.reason });
      }
      continue;
    }
    report.bySource[entry.source] = (report.bySource[entry.source] ?? 0) + 1;
    batch.push(entry);
    if (batch.length >= WRITE_BATCH) await flush();
  }
  await flush();
  return report;
}

/** One destination as a suppression entry, or why it is not one. */
function toEntry(
  d: SuppressedDestination,
  orgId: string,
  now: string,
): SuppressionEntry | "unmapped" | "malformed" {
  const email = d.email.trim().toLowerCase();
  if (!usableEmail(email)) return "malformed";
  const mapped = REASON_MAP[d.reason.trim().toUpperCase()];
  if (!mapped) return "unmapped";
  return {
    orgId,
    email,
    source: mapped.source,
    scope: mapped.scope,
    addedAt: d.at ?? now,
  };
}
