/**
 * addressium service: automations — the launch handler for recurring series.
 *
 * EventBridge Scheduler recurring schedules target this handler on each firing
 * (e.g. daily 6am ET) with a RecurringLaunchPayload as Input. On each firing it
 * pulls the series' feed (SSRF-guarded), builds a fresh edition (subject +
 * editorial blocks), stamps an editionKey-idempotent campaign id, and enqueues
 * it to the send queue for the sender to drain. See ARCHITECTURE.md §4.6, §4.16.
 */
import { SqsSendQueue } from "@addressium/adapters-aws";
import { planLaunchDescriptor, type RecurringLaunchPayload, type SendDescriptor } from "@addressium/domain";
import { fetchFeedItems } from "@addressium/svc-feeds";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let _queue: SqsSendQueue | undefined;
const queue = () => (_queue ??= new SqsSendQueue(env("SEND_QUEUE_URL")));

/** Accept the rich payload, or a bare descriptor (legacy) which we wrap. */
function normalize(input: RecurringLaunchPayload | SendDescriptor): RecurringLaunchPayload {
  if ("descriptor" in input) return input;
  return { descriptor: input, editionKey: "edition" };
}

export async function handler(input: RecurringLaunchPayload | SendDescriptor) {
  const payload = normalize(input);
  // Pull + parse the feed for this firing (guarded fetch, pinned IP, size cap).
  const items = payload.feed
    ? await fetchFeedItems(payload.feed.url, payload.feed.format)
    : undefined;
  const descriptor = planLaunchDescriptor(payload, items);
  await queue().enqueue(descriptor);
  return { ok: true, enqueued: descriptor.campaignId };
}
