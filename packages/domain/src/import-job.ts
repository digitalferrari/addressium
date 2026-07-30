/**
 * Running an import as a job rather than a request (docs/ARCHITECTURE.md §4.7,
 * #242).
 *
 * §4.7 promised an async job — S3 upload, then a Lambda — and the code took the
 * whole file inline in the request body. That put three hard ceilings in front of
 * the single largest write the system will ever take: API Gateway's 10 MB
 * payload limit, the Lambda invoke payload limit, and the 29-second integration
 * timeout. None of them is exotic; an ordinary migration list hits all three. And
 * `fileBase64` (#239) inflates a gzipped export by a third on the way through.
 *
 * The failure shape was the worst available. A timeout mid-import leaves a
 * partially-imported list, no resumption point, and no way for the operator to
 * learn which rows landed — while the request they were watching returns a 5xx
 * that says nothing about the subscribers already written. This arrives on day
 * one, from someone deciding whether to trust the product.
 *
 * So the batch record becomes the status endpoint. It is written `running` BEFORE
 * the first row and closed `completed`/`failed` after the last, which means a
 * crashed job is visible as a `running` batch that stopped moving rather than as
 * silence.
 */
import type { ImportBatch } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";
import { importWithMapping, type MappedImportOptions, type MappedImportReport } from "./import-run.js";

/** Reads an uploaded import object back out of blob storage (S3 in prod). */
export interface ImportFileStore {
  /** The uploaded bytes. Gzip is preserved — `parseImportFile` sniffs it. */
  read(key: string): Promise<Uint8Array>;
  /**
   * A short-lived URL the console can PUT the file to directly.
   *
   * Direct-to-storage on purpose: routing the bytes through the API would
   * reintroduce the payload ceiling this whole module exists to remove.
   */
  presignUpload(key: string, contentType?: string): Promise<{ url: string; key: string }>;
}

export interface ImportJobRequest extends Omit<MappedImportOptions, "csv"> {
  /** The uploaded object to read. */
  sourceKey: string;
}

/**
 * Claim a batch id and mark it running, before anything is read (#242).
 *
 * Separate from `runImportJob` because the two happen in different Lambdas: the
 * API claims the batch so it can answer with a batchId the console can poll
 * immediately, and the job picks it up. Claiming after the read would leave a
 * window where an operator has a 202 and nothing to ask about.
 */
export async function startImportJob(
  stores: Stores,
  clock: Clock,
  input: { orgId: string; batchId: string; sourceKey: string; sourceFile?: string },
): Promise<ImportBatch> {
  const batch: ImportBatch = {
    orgId: input.orgId,
    batchId: input.batchId,
    startedAt: clock.now().toISOString(),
    created: 0,
    updated: 0,
    subscriptionsCreated: 0,
    rowCount: 0,
    status: "running",
    sourceKey: input.sourceKey,
    ...(input.sourceFile ? { sourceFile: input.sourceFile } : {}),
  };
  await stores.importBatches.put(batch);
  return batch;
}

/**
 * Read the uploaded object and import it, closing the batch either way (#242).
 *
 * The `catch` is the point. An import that throws must still leave a record
 * saying so — otherwise the batch sits at `running` for ever and the operator
 * cannot distinguish "still working" from "died an hour ago", which is precisely
 * the state that makes a half-imported list unrecoverable in practice. The error
 * is re-thrown after recording so the Lambda still fails and its own alarms fire.
 */
export async function runImportJob(
  stores: Stores,
  clock: Clock,
  files: ImportFileStore,
  req: ImportJobRequest,
): Promise<MappedImportReport> {
  try {
    const bytes = await files.read(req.sourceKey);
    const report = await importWithMapping(stores, clock, { ...req, csv: bytes });
    // `importWithMapping` writes its own batch record with the real counts; this
    // only closes it out. Read-then-write rather than constructing a fresh
    // record, so the counts it just wrote are not clobbered by zeros.
    await closeBatch(stores, clock, req, {
      // Errors in the report are per-row problems, not a failed run — a file
      // where 3 of 40,000 rows had a bad address imported fine. A run only FAILS
      // if it threw, or if nothing at all could be read.
      status: report.created + report.updated === 0 && report.errors.length > 0 ? "failed" : "completed",
      ...(report.errors.length > 0 ? { error: report.errors.slice(0, 3).join("; ") } : {}),
    });
    return report;
  } catch (e) {
    await closeBatch(stores, clock, req, { status: "failed", error: (e as Error).message });
    throw e;
  }
}

async function closeBatch(
  stores: Stores,
  clock: Clock,
  req: ImportJobRequest,
  patch: { status: "completed" | "failed"; error?: string },
): Promise<void> {
  const existing = await stores.importBatches.get(req.orgId, req.batchId as string);
  const base: ImportBatch = existing ?? {
    orgId: req.orgId,
    batchId: req.batchId as string,
    startedAt: clock.now().toISOString(),
    created: 0,
    updated: 0,
    subscriptionsCreated: 0,
    rowCount: 0,
  };
  await stores.importBatches.put({
    ...base,
    sourceKey: req.sourceKey,
    finishedAt: clock.now().toISOString(),
    ...patch,
  });
}

/**
 * The object key an upload lands on (#242).
 *
 * Org-prefixed so an IAM policy or bucket policy can scope by org later, and
 * batch-suffixed so the key is derivable from the batch id — an operator holding
 * a batchId can be told exactly which object it read, and a retry of the same
 * batch reads the same object rather than a new upload nobody linked.
 */
export const importObjectKey = (orgId: string, batchId: string): string =>
  `imports/${orgId}/${batchId}`;
