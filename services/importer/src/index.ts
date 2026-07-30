/**
 * addressium service: importer — the async import JOB (§4.7, #242).
 *
 * Not a route. It is invoked by the API after the console has uploaded a file to
 * S3, and it reads that object itself, so the bytes never traverse API Gateway.
 * That is the whole point: a migration list is the largest single write the
 * system takes, and inline-body import put API Gateway's 10 MB payload limit,
 * the Lambda invoke payload limit and the 29-second integration timeout in front
 * of it — all three reachable with an ordinary list.
 *
 * The batch record is the status endpoint (`GET /orgs/{org}/import/batches`),
 * because an async run outlives the request that started it and there is nowhere
 * else to ask. `runImportJob` closes it `completed` or `failed` either way, so a
 * crashed job reads as a run that stopped rather than as silence.
 *
 * Timeout and memory are set high in the CDK for the same reason. This handler
 * is allowed to take fifteen minutes; the route that starts it is not.
 */
import { DynamoStores, S3ImportFileStore } from "@addressium/adapters-aws";
import { SystemClock, runImportJob, type ImportJobRequest } from "@addressium/domain";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const clock = new SystemClock();
let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));
let _files: S3ImportFileStore | undefined;
const files = () => (_files ??= new S3ImportFileStore(env("IMPORT_BUCKET")));

export async function handler(event: ImportJobRequest) {
  // Errors propagate: `runImportJob` has already recorded the failure on the
  // batch, and a throw here is what makes the Lambda's own error metric — and
  // therefore its alarm — fire. Swallowing it would leave the failure visible
  // only to whoever thought to check the batch list.
  const report = await runImportJob(stores(), clock, files(), event);
  return { ok: true, batchId: event.batchId, report };
}
