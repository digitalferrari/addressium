/**
 * Campaign send (docs/ARCHITECTURE.md §4.4).
 *
 * Resolves confirmed recipients, drops suppressed addresses, archives the
 * generic body + link-map once, then per recipient mints a magic-link token,
 * renders, and hands the message to the EmailSender (SES in prod). Records a
 * "sent" event per recipient.
 */
import type { EmailArchive, EngagementEvent, List } from "@addressium/core";
import type { Clock, EmailSender, MagicLinkSigner, SendDescriptor, Stores } from "./ports.js";
import { buildLinkMap, renderForRecipient } from "./render.js";

/** Alias kept for readability; a campaign send takes a SendDescriptor. */
export type SendCampaignInput = SendDescriptor;

export interface SendResult {
  sent: number;
  suppressed: number;
  /** True if this campaign was already dispatched and was skipped (idempotency). */
  skipped?: boolean;
}

function listUnsubscribeHeader(list: List, sub: string): string {
  // RFC 8058 one-click unsubscribe (docs/ARCHITECTURE.md §6).
  return `<https://unsub.${list.orgId}.example/u?sub=${sub}&list=${list.listId}>`;
}

export async function sendCampaign(
  stores: Stores,
  sender: EmailSender,
  magic: MagicLinkSigner,
  clock: Clock,
  input: SendCampaignInput,
): Promise<SendResult> {
  const list = await stores.lists.get(input.orgId, input.listId);
  if (!list) throw new Error("unknown list");

  // Idempotency: SQS is at-least-once, so claim the campaign exactly once (#21).
  if (!(await stores.sendClaims.claim(input.orgId, input.campaignId))) {
    return { sent: 0, suppressed: 0, skipped: true };
  }

  // Archive the generic body once (§4.8) — powers the click overlay.
  const linkMap = buildLinkMap(input.template);
  const archive: EmailArchive = {
    orgId: input.orgId,
    campaignId: input.campaignId,
    s3Key: `archive/${input.orgId}/${input.campaignId}.html`,
    linkMap,
  };
  await stores.archive.put(archive);

  const confirmed = await stores.subscriptions.listConfirmed(input.orgId, input.listId);
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
