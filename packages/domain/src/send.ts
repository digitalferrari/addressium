/**
 * Campaign send (docs/ARCHITECTURE.md §4.4).
 *
 * Resolves confirmed recipients, drops suppressed addresses, archives the
 * generic body + link-map once, then per recipient mints a magic-link token,
 * renders, and hands the message to the EmailSender (SES in prod). Records a
 * "sent" event per recipient.
 */
import type { EmailArchive, EngagementEvent, List } from "@addressium/core";
import type {
  Clock,
  EmailSender,
  MagicLinkSigner,
  SendDescriptor,
  SendQueue,
  SendThrottle,
  Stores,
} from "./ports.js";
import { buildLinkMap, renderForRecipient, type EmailTemplate } from "./render.js";

/** Alias kept for readability; a campaign send takes a SendDescriptor. */
export type SendCampaignInput = SendDescriptor;

export interface SendOptions {
  /** Paces per-recipient sends to the SES rate (§4.4). */
  throttle?: SendThrottle;
}

export interface SendResult {
  sent: number;
  suppressed: number;
  /** True if this campaign (or slice) was already dispatched and was skipped. */
  skipped?: boolean;
}

/** Idempotency claim key — per-slice when fanned out, else whole-campaign. */
function claimKey(input: SendDescriptor): string {
  return input.slice ? `${input.campaignId}#${input.slice.offset}` : input.campaignId;
}

/** Split a confirmed-recipient count into offset/limit windows of `chunkSize`. */
export function planFanOut(total: number, chunkSize: number): Array<{ offset: number; limit: number }> {
  if (chunkSize <= 0) throw new Error("chunkSize must be > 0");
  const slices: Array<{ offset: number; limit: number }> = [];
  for (let offset = 0; offset < total; offset += chunkSize) {
    slices.push({ offset, limit: Math.min(chunkSize, total - offset) });
  }
  return slices;
}

/**
 * Fan a large campaign out across the queue: count confirmed recipients and, if
 * they exceed `chunkSize`, enqueue one sliced descriptor per window so the
 * sender processes them in parallel. Returns the slices enqueued (empty when
 * the list fits in one message and no fan-out was needed).
 */
export async function fanOutCampaign(
  stores: Stores,
  queue: SendQueue,
  descriptor: SendDescriptor,
  chunkSize: number,
): Promise<Array<{ offset: number; limit: number }>> {
  const confirmed = await stores.subscriptions.listConfirmed(descriptor.orgId, descriptor.listId);
  if (confirmed.length <= chunkSize) return [];
  const slices = planFanOut(confirmed.length, chunkSize);
  for (const slice of slices) {
    await queue.enqueue({ ...descriptor, slice });
  }
  return slices;
}

function listUnsubscribeHeader(list: List, sub: string): string {
  // RFC 8058 one-click unsubscribe (docs/ARCHITECTURE.md §6).
  return `<https://unsub.${list.orgId}.example/u?sub=${sub}&list=${list.listId}>`;
}

export interface SendOneInput {
  orgId: string;
  /** Distinct id for this per-recipient send (idempotency + event grouping). */
  campaignId: string;
  subscriberId: string;
  listId: string;
  subject: string;
  template: EmailTemplate;
  /** Optional pacing — acquired only for an actual send (skips don't burn tokens). */
  throttle?: SendThrottle;
}

export interface SendOneResult {
  sent: boolean;
  reason?: "unknown-subscriber" | "suppressed" | "already-sent";
}

/**
 * Send one message to one subscriber (drip step / transactional, §4.6). Applies
 * the same suppression gate, magic-link minting, render and sent-event append as
 * a campaign send, with per-(campaign,subscriber) idempotency.
 */
export async function sendToSubscriber(
  stores: Stores,
  sender: EmailSender,
  magic: MagicLinkSigner,
  clock: Clock,
  input: SendOneInput,
): Promise<SendOneResult> {
  const list = await stores.lists.get(input.orgId, input.listId);
  if (!list) throw new Error("unknown list");
  if (!(await stores.sendClaims.claim(input.orgId, `${input.campaignId}#${input.subscriberId}`))) {
    return { sent: false, reason: "already-sent" };
  }
  const subscriber = await stores.subscribers.get(input.orgId, input.subscriberId);
  if (!subscriber) return { sent: false, reason: "unknown-subscriber" };
  if (await stores.suppression.isSuppressed(input.orgId, subscriber.email)) {
    return { sent: false, reason: "suppressed" };
  }
  if (input.throttle) await input.throttle.acquire();
  const token = await magic.mint({
    orgId: subscriber.orgId,
    sub: subscriber.sub,
    entitlement: subscriber.entitlement,
    entitlementAsof: subscriber.entitlementAsof,
  });
  await sender.send({
    from: list.fromAddress,
    to: subscriber.email,
    subject: input.subject,
    html: renderForRecipient(input.template, subscriber.attributes, token),
    listUnsubscribe: listUnsubscribeHeader(list, subscriber.sub),
  });
  await stores.events.append({
    orgId: input.orgId,
    subscriberId: subscriber.sub,
    campaignId: input.campaignId,
    type: "sent",
    at: clock.now().toISOString(),
  });
  return { sent: true };
}

export async function sendCampaign(
  stores: Stores,
  sender: EmailSender,
  magic: MagicLinkSigner,
  clock: Clock,
  input: SendCampaignInput,
  opts: SendOptions = {},
): Promise<SendResult> {
  const list = await stores.lists.get(input.orgId, input.listId);
  if (!list) throw new Error("unknown list");

  // Idempotency: SQS is at-least-once, so claim each unit (campaign or slice)
  // exactly once (#21). Fanned-out slices claim independently (#9).
  if (!(await stores.sendClaims.claim(input.orgId, claimKey(input)))) {
    return { sent: 0, suppressed: 0, skipped: true };
  }

  // Archive the generic body (§4.8) — powers the click overlay. Deterministic
  // put keyed by campaignId, so repeating it across slices is harmless.
  const linkMap = buildLinkMap(input.template);
  const archive: EmailArchive = {
    orgId: input.orgId,
    campaignId: input.campaignId,
    s3Key: `archive/${input.orgId}/${input.campaignId}.html`,
    linkMap,
  };
  await stores.archive.put(archive);

  const all = await stores.subscriptions.listConfirmed(input.orgId, input.listId);
  // A slice sends only its window of the confirmed set; no slice → the whole list.
  const confirmed = input.slice
    ? all.slice(input.slice.offset, input.slice.offset + input.slice.limit)
    : all;
  let sent = 0;
  let suppressed = 0;

  for (const sub of confirmed) {
    const subscriber = await stores.subscribers.get(input.orgId, sub.subscriberId);
    if (!subscriber) continue;

    // Suppression enforced before every send (§4.4, §4.13).
    if (await stores.suppression.isSuppressed(input.orgId, subscriber.email)) {
      suppressed++;
      continue;
    }

    // Throttle only actual sends so skipped/suppressed rows don't burn tokens.
    if (opts.throttle) await opts.throttle.acquire();

    const token = await magic.mint({
      orgId: subscriber.orgId,
      sub: subscriber.sub,
      entitlement: subscriber.entitlement,
      entitlementAsof: subscriber.entitlementAsof,
    });
    const html = renderForRecipient(input.template, subscriber.attributes, token);

    await sender.send({
      from: list.fromAddress,
      to: subscriber.email,
      subject: input.subject,
      html,
      listUnsubscribe: listUnsubscribeHeader(list, subscriber.sub),
    });

    const evt: EngagementEvent = {
      orgId: input.orgId,
      subscriberId: subscriber.sub,
      campaignId: input.campaignId,
      type: "sent",
      at: clock.now().toISOString(),
    };
    await stores.events.append(evt);
    sent++;
  }

  return { sent, suppressed };
}
