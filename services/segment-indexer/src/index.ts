/**
 * addressium service: segment-indexer (§5, #28) — opt-in OpenSearch mirror.
 *
 * DynamoDB Streams → this handler → OpenSearch. It filters to subscriber items,
 * resolves each subscriber's confirmed list memberships, projects them into the
 * mirror document, and bulk-writes index/delete ops. Only runs when the mirror
 * is enabled in infra (the table stream + collection are created behind a flag).
 */
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoStores, OpenSearchBulkWriter } from "@addressium/adapters-aws";
import { subscriberToIndexOp, type IndexOp } from "@addressium/segment";
import type { Subscriber } from "@addressium/core";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));
let _writer: OpenSearchBulkWriter | undefined;
const writer = () => (_writer ??= new OpenSearchBulkWriter(env("OPENSEARCH_ENDPOINT")));

interface StreamRecord {
  eventName: "INSERT" | "MODIFY" | "REMOVE";
  dynamodb?: {
    Keys?: Record<string, unknown>;
    NewImage?: Record<string, unknown>;
    OldImage?: Record<string, unknown>;
  };
}

export async function handler(event: { Records: StreamRecord[] }) {
  const ops: IndexOp[] = [];
  for (const record of event.Records ?? []) {
    const keys = record.dynamodb?.Keys ? (unmarshall(record.dynamodb.Keys as never) as { sk?: string }) : {};
    if (!keys.sk?.startsWith("SUBSCRIBER#")) continue; // only mirror subscribers

    if (record.eventName === "REMOVE") {
      const old = unmarshall(record.dynamodb!.OldImage as never) as { data: Subscriber };
      ops.push(subscriberToIndexOp("REMOVE", old.data));
      continue;
    }
    const img = unmarshall(record.dynamodb!.NewImage as never) as { data: Subscriber };
    const subscriber = img.data;
    const subs = await stores().subscriptions.listBySubscriber(subscriber.orgId, subscriber.sub);
    const confirmed = subs.filter((s) => s.status === "confirmed").map((s) => s.listId);
    ops.push(subscriberToIndexOp(record.eventName, subscriber, confirmed));
  }
  await writer().bulk(ops);
  return { ok: true, indexed: ops.length };
}
