/**
 * addressium service: importer — Pinpoint / CSV subscriber migration (§4.7).
 *
 * Accepts a CSV body (header row + rows), maps `email` + attribute columns to
 * subscribers, dedupes within the batch, skips suppressed addresses, and
 * creates/updates the subscriber plus a subscription on the target list.
 * `dryRun` reports counts without writing.
 */
import { DynamoStores } from "@addressium/adapters-aws";
import { SystemClock, importCsvSubscribers } from "@addressium/domain";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const clock = new SystemClock();
let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));

export interface ImportEvent {
  orgId: string;
  listId: string;
  csv: string;
  status?: "confirmed" | "pending";
  dryRun?: boolean;
}

export async function handler(event: ImportEvent) {
  const report = await importCsvSubscribers(stores(), clock, {
    orgId: event.orgId,
    listId: event.listId,
    csv: event.csv,
    status: event.status,
    dryRun: event.dryRun,
  });
  return { ok: true, report };
}
