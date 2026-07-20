/**
 * addressium service: sender — drains the SQS send queue and sends via SES.
 *
 * Every send path funnels through the queue: "send now" (API enqueues),
 * one-off scheduled (EventBridge Scheduler targets the queue), and recurring
 * (the launch handler enqueues each edition). This handler parses SQS records
 * and calls the pure sendCampaign() domain function. See ARCHITECTURE.md §4.4.
 */
import { depsFromEnv, type Deps } from "@addressium/adapters-aws";
import { sendCampaign, type SendDescriptor } from "@addressium/domain";

export interface SqsEvent {
  Records: Array<{ body: string; messageId?: string }>;
}

let _deps: Deps | undefined;
const deps = () => (_deps ??= depsFromEnv());

export async function handler(event: SqsEvent) {
  const d = deps();
  const results = [];
  for (const record of event.Records ?? []) {
    const descriptor = JSON.parse(record.body) as SendDescriptor;
    // TODO: token-bucket throttle across records to respect the SES rate.
    results.push(await sendCampaign(d.stores, d.sender, d.magic, d.clock, descriptor));
  }
  return { batchItemFailures: [], results };
}
