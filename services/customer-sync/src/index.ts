import { DynamoStores, getSecret } from "@addressium/adapters-aws";

interface CustomerSyncEvent {
  eventId: string;
  type: "subscribed" | "unsubscribed";
  orgId: string;
  subscriberId: string;
  externalId: string;
  email: string;
  listId: string;
  occurredAt: string;
}

interface SqsRecord { messageId?: string; body?: string }
interface SqsEvent { Records?: SqsRecord[] }

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

const stores = new DynamoStores(env("TABLE_NAME"));

async function deliver(event: CustomerSyncEvent): Promise<void> {
  const org = await stores.organizations.get(event.orgId);
  const config = org?.customerSync;
  if (!config?.enabled || !config.secretRef) return;
  const secret = await getSecret(config.secretRef);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-addressium-event-id": event.eventId,
        "x-addressium-secret": secret,
      },
      body: JSON.stringify({ ...event, tableName: config.tableName }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`customer endpoint returned ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function handler(event: SqsEvent) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    if (!record.messageId) continue;
    try {
      const payload = JSON.parse(record.body ?? "") as CustomerSyncEvent;
      if (!payload.eventId || !payload.orgId || !payload.externalId || !payload.listId) {
        console.warn("customer-sync: malformed message", { messageId: record.messageId });
        continue;
      }
      await deliver(payload);
    } catch (error) {
      console.error("customer-sync: delivery failed", { messageId: record.messageId, error: (error as Error).message });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
