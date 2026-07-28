/**
 * Applying a validated import mapping (docs/ARCHITECTURE.md §4.7, #216).
 *
 * `import-mapping.ts` decides what each column *means*; this decides what gets
 * written. Split because the mapping half must stay pure — the console previews
 * a file with the same code that later imports it, so the preview cannot lie.
 *
 * Three rules the write path exists to enforce:
 *
 *  1. A non-mailable row is still imported. `OptOut: ALL` and
 *     `EndpointStatus: INACTIVE` are records we must keep — dropping them loses
 *     the very opt-out we are being told about, and the address gets re-imported
 *     as fresh from the next file. They are written as subscribers, never as
 *     active subscriptions, and their declines are recorded (#209).
 *  2. Only `subscribed` becomes a subscription. `declined` writes an
 *     `unsubscribed` row so the decision survives; `unknown` writes nothing at
 *     all, because the subscriber was never asked (#209).
 *  3. A list created during import needs real compliance fields. Inventing a
 *     from-address or an empty physical address would ship a CAN-SPAM violation,
 *     so the caller must supply them — there is no default.
 */
import { randomUUID } from "node:crypto";
import type {
  ImportBatch,
  List,
  Subscriber,
  Subscription,
  SubscriptionStatus,
} from "@addressium/core";
import {
  applyMapping,
  validateMapping,
  type ConsentBasis,
  type MappedRow,
  type MappingPlan,
} from "./import-mapping.js";
import { parseCsv } from "./importer.js";
import type { Clock, Stores } from "./ports.js";

/** Compliance fields a newly created list cannot be given a sensible default for. */
export interface NewListDefaults {
  fromAddress: string;
  complianceFooter: string;
  physicalAddress: string;
  optInPolicy?: List["optInPolicy"];
  access?: List["access"];
  visibility?: List["visibility"];
}

export interface MappedImportOptions {
  orgId: string;
  csv: string;
  plan: MappingPlan;
  /**
   * Identifies this run, stamped on every subscription it writes (#223). An
   * operator who discovers a bad file needs to find its rows again; without a
   * batch id the only handle is "everything imported around then".
   */
  batchId?: string;
  /** The uploaded file's name, recorded alongside the batch for the same reason. */
  sourceFile?: string;
  /**
   * Status for subscriptions created from a `subscribed` column. Defaults to
   * `pending` (#192) — silently confirming an uploaded list bypasses double
   * opt-in and records no consent.
   */
  status?: Extract<SubscriptionStatus, "confirmed" | "pending">;
  /** Required only if the plan creates a list by name. */
  newListDefaults?: NewListDefaults;
  dryRun?: boolean;
}

export interface MappedImportReport {
  created: number;
  updated: number;
  /** Rows imported as records but given no active subscription. */
  nonMailable: number;
  duplicates: number;
  suppressed: number;
  subscriptionsCreated: number;
  declinesRecorded: number;
  listsCreated: string[];
  /** Per source column, how many cells were dropped — so a discard is never silent. */
  discardedCells: number;
  errors: string[];
}

const emptyReport = (): MappedImportReport => ({
  created: 0,
  updated: 0,
  nonMailable: 0,
  duplicates: 0,
  suppressed: 0,
  subscriptionsCreated: 0,
  declinesRecorded: 0,
  listsCreated: [],
  discardedCells: 0,
  errors: [],
});

/**
 * The subscription status a basis permits (#223, compendium item 60).
 *
 * `implicit` means an existing relationship, not proof of opt-in, so it can only
 * ever produce `pending` — the subscriber still has to confirm. Previously the
 * pending default was unconditional and unrelated to the basis, so a caller
 * could pass `status: "confirmed"` alongside an implicit basis and mail a list
 * that had never opted in. `explicit` means the file carries double opt-in
 * evidence, so the caller's choice is honoured.
 */
export function statusFor(
  basis: ConsentBasis | undefined,
  requested: Extract<SubscriptionStatus, "confirmed" | "pending"> | undefined,
): Extract<SubscriptionStatus, "confirmed" | "pending"> {
  if (basis !== "explicit") return "pending";
  return requested ?? "pending";
}

/**
 * Columns that cannot support a `confirmed` import (#223).
 *
 * `statusFor` fails closed, so an implicit basis could never *produce* a
 * confirmed subscription — but silently downgrading leaves an operator who asked
 * to import a confirmed list believing it is mailable. This names the columns
 * that block the request so the caller can be refused with a reason.
 *
 * Lives here rather than in the API handler because it is the same consent rule
 * `statusFor` encodes; two copies in two layers is how the two drift.
 */
export function columnsBlockingConfirmed(plan: MappingPlan): string[] {
  return Object.entries(plan.columns)
    .filter(([, m]) => m.kind === "audience" && m.consentBasis !== "explicit")
    .map(([header]) => header);
}

/** Deterministic id so re-running an import does not create a second copy of the same list. */
const listIdFor = (name: string): string =>
  `imp_${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)}`;

/**
 * Resolve every list the plan references, creating the named ones once up front.
 * Done before any row is processed so a mid-file failure cannot leave half the
 * audiences existing.
 */
async function resolveLists(
  stores: Stores,
  opts: MappedImportOptions,
  report: MappedImportReport,
): Promise<Map<string, string> | undefined> {
  const wanted = new Set<string>();
  for (const m of Object.values(opts.plan.columns)) {
    if (m.kind === "audience" && "createNamed" in m.list) wanted.add(m.list.createNamed);
  }
  const byName = new Map<string, string>();
  if (wanted.size === 0) return byName;

  const d = opts.newListDefaults;
  if (!d) {
    report.errors.push(
      `the mapping creates ${wanted.size} list(s) but no newListDefaults were supplied — ` +
        `a list needs a from-address, a compliance footer and a physical address`,
    );
    return undefined;
  }

  const existing = await stores.lists.list(opts.orgId);
  for (const name of wanted) {
    const match = existing.find((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (match) {
      byName.set(name, match.listId);
      continue;
    }
    const listId = listIdFor(name);
    byName.set(name, listId);
    report.listsCreated.push(listId);
    if (opts.dryRun) continue;
    const list: List = {
      orgId: opts.orgId,
      listId,
      name,
      optInPolicy: d.optInPolicy ?? "double",
      fromAddress: d.fromAddress,
      access: d.access ?? "free",
      visibility: d.visibility ?? "closed",
      complianceFooter: d.complianceFooter,
      physicalAddress: d.physicalAddress,
    };
    await stores.lists.put(list);
  }
  return byName;
}

const listIdOf = (
  list: { existingId: string } | { createNamed: string },
  byName: Map<string, string>,
): string | undefined => ("existingId" in list ? list.existingId : byName.get(list.createNamed));

/**
 * Import a CSV through a validated mapping. Rejects an invalid plan before
 * writing anything rather than importing the rows it happens to understand.
 */
export async function importWithMapping(
  stores: Stores,
  clock: Clock,
  opts: MappedImportOptions,
): Promise<MappedImportReport> {
  const report = emptyReport();
  const rows = parseCsv(opts.csv);
  if (rows.length === 0) {
    report.errors.push("file contains no data rows");
    return report;
  }

  const headers = Object.keys(rows[0] as Record<string, string>);
  const problems = validateMapping(opts.plan, headers);
  if (problems.length > 0) {
    for (const p of problems) report.errors.push(p.column ? `${p.column}: ${p.problem}` : p.problem);
    return report;
  }

  const byName = await resolveLists(stores, opts, report);
  if (!byName) return report;

  const now = clock.now().toISOString();
  const seen = new Set<string>();

  // The batch record is written BEFORE the first row, not after the last. An
  // import that dies halfway is exactly the one an operator needs to find, and a
  // record written only on success would be missing for precisely those runs.
  // Counts are refreshed at the end; until then they read zero, which is honest
  // for a run still in flight.
  const recordBatch = Boolean(opts.batchId) && !opts.dryRun;
  if (recordBatch) await putBatch(stores, opts, report, now);

  for (const [index, row] of rows.entries()) {
    const mapped: MappedRow = applyMapping(opts.plan, row);
    report.discardedCells += mapped.discardedColumns;

    if (!mapped.email.includes("@")) {
      // The file's own line number (header is line 1), so an operator can find
      // the row in a 50,000-line upload. Counters would repeat the same number
      // for every rejected row, which is worse than no number at all.
      report.errors.push(`line ${index + 2}: ${mapped.reasons.join("; ")}`);
      continue;
    }
    if (seen.has(mapped.email)) {
      report.duplicates++;
      continue;
    }
    seen.add(mapped.email);

    // A suppressed address is never resurrected by an upload, whatever the file says.
    if (await stores.suppression.isSuppressed(opts.orgId, mapped.email)) {
      report.suppressed++;
      continue;
    }
    if (!mapped.mailable) report.nonMailable++;

    const existing = await stores.subscribers.findByEmail(opts.orgId, mapped.email);
    if (opts.dryRun) {
      existing ? report.updated++ : report.created++;
      countSubscriptions(mapped, byName, report);
      continue;
    }

    let subscriber: Subscriber;
    if (existing) {
      subscriber = { ...existing, attributes: { ...existing.attributes, ...mapped.attributes } };
      await stores.subscribers.put(subscriber);
      report.updated++;
    } else {
      subscriber = {
        orgId: opts.orgId,
        sub: randomUUID(),
        email: mapped.email,
        attributes: mapped.attributes,
        source: "import",
        status: "active",
        entitlement: "free",
      };
      await stores.subscribers.put(subscriber);
      report.created++;
    }

    await writeSubscriptions(stores, opts, mapped, byName, subscriber.sub, now, report);
  }

  if (recordBatch) await putBatch(stores, opts, report, now);
  return report;
}

/**
 * The batch record (#223). `rowCount` counts memberships written, which is what
 * `listRows` returns — deliberately not the file's line count, so the two
 * numbers an operator compares are the same measurement.
 */
async function putBatch(
  stores: Stores,
  opts: MappedImportOptions,
  report: MappedImportReport,
  startedAt: string,
): Promise<void> {
  const bases = new Set(
    Object.values(opts.plan.columns)
      .flatMap((m) => (m.kind === "audience" ? [m.consentBasis] : []))
      .filter(Boolean),
  );
  const batch: ImportBatch = {
    orgId: opts.orgId,
    batchId: opts.batchId as string,
    startedAt,
    created: report.created,
    updated: report.updated,
    subscriptionsCreated: report.subscriptionsCreated,
    rowCount: report.subscriptionsCreated + report.declinesRecorded,
    ...(opts.sourceFile ? { sourceFile: opts.sourceFile } : {}),
    // Only when the whole file agrees. A mixed-basis import has no single
    // answer, and guessing one would misstate what consent the rows carry.
    ...(bases.size === 1 ? { consentBasis: [...bases][0] as ConsentBasis } : {}),
  };
  await stores.importBatches.put(batch);
}

/** Dry-run accounting, kept beside the write path so the two cannot drift. */
function countSubscriptions(
  mapped: MappedRow,
  byName: Map<string, string>,
  report: MappedImportReport,
): void {
  if (mapped.mailable) {
    for (const a of mapped.audiences) if (listIdOf(a.list, byName)) report.subscriptionsCreated++;
  }
  for (const d of mapped.declined) if (listIdOf(d.list, byName)) report.declinesRecorded++;
}

async function writeSubscriptions(
  stores: Stores,
  opts: MappedImportOptions,
  mapped: MappedRow,
  byName: Map<string, string>,
  subscriberId: string,
  now: string,
  report: MappedImportReport,
): Promise<void> {
  const write = async (
    listId: string,
    status: SubscriptionStatus,
    basis?: ConsentBasis,
  ): Promise<void> => {
    const subscription: Subscription = {
      orgId: opts.orgId,
      subscriberId,
      listId,
      status,
      updatedAt: now,
      // The same field a double-opt-in signup writes (#220), so one lookup
      // answers "what proves we may mail this person about this list" whether
      // they signed up or arrived in a file.
      consent: {
        requestedAt: now,
        ...(basis ? { basis } : {}),
        ...(opts.batchId ? { importBatchId: opts.batchId } : {}),
        ...(opts.sourceFile ? { sourceUrl: opts.sourceFile } : {}),
      },
    };
    await stores.subscriptions.put(subscription);
    // The pointer is what makes a batch reversible: `consent.importBatchId` is
    // on the subscription, but finding every subscription with a given batch id
    // means scanning the org. Written for declines too — an import that recorded
    // a "no" against the wrong list must be reversible the same way.
    if (opts.batchId) {
      await stores.importBatches.addRow(opts.orgId, opts.batchId, subscriberId, listId);
    }
  };

  // A row the file tells us not to mail gets NO active subscription, even where
  // a column says `true` — the row-level opt-out outranks the per-list flag.
  if (mapped.mailable) {
    for (const a of mapped.audiences) {
      const listId = listIdOf(a.list, byName);
      if (!listId) continue;
      await write(listId, statusFor(a.consentBasis, opts.status), a.consentBasis);
      report.subscriptionsCreated++;
    }
  }

  // Declines are persisted, not dropped. An explicit "no" that we fail to record
  // is a "no" the next import will not know about.
  for (const d of mapped.declined) {
    const listId = listIdOf(d.list, byName);
    if (!listId) continue;
    await write(listId, "unsubscribed");
    report.declinesRecorded++;
  }
}
