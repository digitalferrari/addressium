/**
 * Bulk export / portability (docs/ARCHITECTURE.md §4.19, #224, compendium #58).
 *
 * The project's stated promise is "subscriber data never leaves the operator's
 * AWS account, and they can export it at any time." The first half was true and
 * the second was not: the only export was a single-subject GDPR DSAR, so a
 * publisher who wanted to leave had no way to take their list with them. For a
 * product whose pitch is escaping vendor lock-in, no exit path is the
 * credibility gap.
 *
 * THE DESIGN RULE — the export must be re-importable by the mapper (#216)
 * without hand-editing. An export nobody can read back is a file, not
 * portability. So the CSV shape is deliberately one row per (subscriber, list),
 * with the columns `suggestMapping` already recognises: `email` maps itself, and
 * the consent columns carry the provenance a re-import must preserve.
 *
 * JSONL is the lossless form — nested attributes survive as objects — and CSV
 * is the one a spreadsheet and the mapper can both read.
 */
import type { Subscriber, Subscription, SuppressionEntry } from "@addressium/core";
import type { Stores } from "./ports.js";

export interface ExportRow {
  email: string;
  subscriberId: string;
  status: Subscriber["status"];
  entitlement: Subscriber["entitlement"];
  externalId?: string;
  listId: string;
  subscriptionStatus: Subscription["status"];
  updatedAt: string;
  /** Consent provenance — the part a round trip must not lose (#220, #223). */
  consentRequestedAt?: string;
  consentConfirmedAt?: string;
  consentBasis?: string;
  consentSourceUrl?: string;
  importBatchId?: string;
  suppressed: boolean;
  suppressionSource?: string;
  attributes: Record<string, string>;
}

/** Columns emitted in this order; attribute keys are appended after them. */
const FIXED_COLUMNS: (keyof ExportRow)[] = [
  "email",
  "subscriberId",
  "status",
  "entitlement",
  "externalId",
  "listId",
  "subscriptionStatus",
  "updatedAt",
  "consentRequestedAt",
  "consentConfirmedAt",
  "consentBasis",
  "consentSourceUrl",
  "importBatchId",
  "suppressed",
  "suppressionSource",
];

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  // Quote when the value contains a delimiter, a quote or a newline — the same
  // rule parseCsv understands, so a round trip survives commas in an attribute.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ExportOptions {
  orgId: string;
  /** Restrict to one list; omit for every subscription in the org. */
  listId?: string;
  /**
   * Include subscribers with no subscription at all. Off by default: the row
   * shape is per-subscription, and a subscriber with none would emit a row with
   * an empty listId that the mapper cannot re-attach to anything.
   */
  includeUnsubscribed?: boolean;
}

/**
 * Build the export rows. Deliberately a generator: an org's whole subscriber
 * base does not belong in one array in Lambda memory (#182), and a streaming
 * writer can consume this without materialising the export.
 */
export async function* exportRows(stores: Stores, opts: ExportOptions): AsyncGenerator<ExportRow> {
  for await (const s of stores.subscribers.stream(opts.orgId)) {
    const subs = await stores.subscriptions.listBySubscriber(opts.orgId, s.sub);
    const entries: SuppressionEntry[] = await stores.suppression.entriesFor(opts.orgId, s.email);
    const suppressed = entries.length > 0;

    for (const sub of subs) {
      if (opts.listId && sub.listId !== opts.listId) continue;
      if (!opts.includeUnsubscribed && sub.status === "unsubscribed") continue;
      yield {
        email: s.email,
        subscriberId: s.sub,
        status: s.status,
        entitlement: s.entitlement,
        ...(s.externalId ? { externalId: s.externalId } : {}),
        listId: sub.listId,
        subscriptionStatus: sub.status,
        updatedAt: sub.updatedAt,
        ...(sub.consent?.requestedAt ? { consentRequestedAt: sub.consent.requestedAt } : {}),
        ...(sub.consent?.confirmedAt ? { consentConfirmedAt: sub.consent.confirmedAt } : {}),
        ...(sub.consent?.basis ? { consentBasis: sub.consent.basis } : {}),
        ...(sub.consent?.sourceUrl ? { consentSourceUrl: sub.consent.sourceUrl } : {}),
        ...(sub.consent?.importBatchId ? { importBatchId: sub.consent.importBatchId } : {}),
        suppressed,
        ...(entries[0]?.source ? { suppressionSource: entries[0].source } : {}),
        attributes: s.attributes,
      };
    }
  }
}

/**
 * CSV, re-importable by the mapper. Attribute keys become their own columns —
 * a single JSON blob in one cell would round-trip as an opaque string rather
 * than as attributes.
 */
export async function* exportCsvChunks(
  stores: Stores,
  opts: ExportOptions,
): AsyncGenerator<string> {
  // Two passes, deliberately. A CSV header must name every attribute column
  // before the first data row, and attribute keys vary per subscriber — so the
  // choice is between holding every ROW in memory to learn the key set, or
  // reading the subscribers twice and holding only the KEYS. The key set is
  // bounded by the org's schema; the row set is bounded by nothing. Double
  // Dynamo reads are the cheaper half of that trade, and this is the path that
  // has to survive the largest org in the deployment.
  const attrKeys = new Set<string>();
  for await (const r of exportRows(stores, opts)) {
    for (const k of Object.keys(r.attributes)) attrKeys.add(k);
  }
  const attrCols = [...attrKeys].sort();
  yield [...FIXED_COLUMNS, ...attrCols.map((k) => `attr.${k}`)].join(",") + "\n";

  for await (const r of exportRows(stores, opts)) {
    const fixed = FIXED_COLUMNS.map((c) => csvCell(r[c]));
    const attrs = attrCols.map((k) => csvCell(r.attributes[k]));
    yield [...fixed, ...attrs].join(",") + "\n";
  }
}

/** Buffered CSV. Fine for a console preview; use the chunk form for a real export. */
export async function exportCsv(stores: Stores, opts: ExportOptions): Promise<string> {
  return collect(exportCsvChunks(stores, opts));
}

/**
 * JSON Lines — lossless, one row per line. Genuinely single-pass: there is no
 * header to declare, so a row can be emitted the moment it is read.
 */
export async function* exportJsonlChunks(
  stores: Stores,
  opts: ExportOptions,
): AsyncGenerator<string> {
  for await (const r of exportRows(stores, opts)) yield JSON.stringify(r) + "\n";
}

/** Buffered JSONL. Same caveat as `exportCsv`. */
export async function exportJsonl(stores: Stores, opts: ExportOptions): Promise<string> {
  return collect(exportJsonlChunks(stores, opts));
}

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  const out: string[] = [];
  for await (const c of chunks) out.push(c);
  return out.join("");
}

/**
 * A mapping that re-imports an export produced by `exportCsv`, so the round trip
 * needs no hand-mapping. Suppression state is deliberately NOT re-imported as a
 * subscription: `importWithMapping` consults the suppression list itself, and a
 * re-import must never resurrect a suppressed address.
 */
export function exportReimportPlan(header: string[]): { columns: Record<string, { kind: string } & Record<string, unknown>> } {
  const columns: Record<string, { kind: string } & Record<string, unknown>> = {};
  for (const h of header) {
    if (h === "email") columns[h] = { kind: "email" };
    else if (h.startsWith("attr.")) columns[h] = { kind: "attribute", key: h.slice(5) };
    else columns[h] = { kind: "discard" };
  }
  return { columns };
}
