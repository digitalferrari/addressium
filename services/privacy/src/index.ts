/**
 * addressium service: privacy — GDPR/CCPA data-subject requests (§4.19).
 *
 * export → returns the person's record; erase → anonymizes profile,
 * unsubscribes everywhere, writes a suppression tombstone. Admin-invoked.
 */
import { DynamoStores } from "@addressium/adapters-aws";
import { SystemClock, eraseSubscriber, exportSubscriber } from "@addressium/domain";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const clock = new SystemClock();
let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));

export interface PrivacyEvent {
  action: "export" | "erase";
  orgId: string;
  email: string;
}

export async function handler(event: PrivacyEvent) {
  const s = stores();
  if (event.action === "export") {
    const data = await exportSubscriber(s, event.orgId, event.email);
    return { ok: true, found: data !== undefined, data };
  }
  if (event.action === "erase") {
    const erased = await eraseSubscriber(s, clock, event.orgId, event.email);
    return { ok: true, erased };
  }
  throw new Error(`unknown action ${String((event as { action?: string }).action)}`);
}
