/**
 * addressium service: automations — the launch handler for recurring series.
 *
 * EventBridge Scheduler recurring schedules target this handler on each firing
 * (e.g. daily 6am ET). It builds the edition and enqueues it to the send queue,
 * which the sender drains. Drip/journey Step Functions also live here later.
 * See docs/ARCHITECTURE.md §4.6, §4.16.
 */
import { SqsSendQueue } from "@addressium/adapters-aws";
import type { SendDescriptor } from "@addressium/domain";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let _queue: SqsSendQueue | undefined;
const queue = () => (_queue ??= new SqsSendQueue(env("SEND_QUEUE_URL")));

/** Fired by EventBridge Scheduler with the series' send descriptor as Input. */
export async function handler(payload: SendDescriptor) {
  // TODO: pull the series' feed content and stamp a fresh edition id + subject
  // before enqueueing (§4.16). For now the recurring descriptor is enqueued as-is.
  await queue().enqueue(payload);
  return { ok: true, enqueued: payload.campaignId };
}
