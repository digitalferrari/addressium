/**
 * One-time resend to a campaign's non-engaged recipients (#54).
 *
 * An Advertising Director wants to recover missed opens: take everyone who
 * *received* the last email but never opened it or clicked a link, and resend
 * once (usually with a fresh subject). The non-engaged set is derived from the
 * same append-only engagement log the click map uses (#13) — subscribers with a
 * `sent`/`delivered` event but no `open` and no `click`. The resend goes out
 * under a distinct `{campaign}#resend` sub-campaign id so its opens/clicks
 * aggregate separately (same convention as the A/B sub-campaigns, #25), reuses
 * `sendToSubscriber` for the suppression gate + magic-link + per-recipient
 * idempotency, so triggering the resend twice is a no-op.
 */
import type { EngagementEvent } from "@addressium/core";
import type { Clock, EmailSender, MagicLinkSigner, SendThrottle, Stores } from "./ports.js";
import type { EmailTemplate } from "./render.js";
import { sendToSubscriber } from "./send.js";

/** Suffix marking a resend sub-campaign; its events aggregate on their own. */
export const RESEND_SUFFIX = "#resend";

export function resendCampaignId(originalCampaignId: string): string {
  return `${originalCampaignId}${RESEND_SUFFIX}`;
}

/**
 * Subscribers who received the campaign but never engaged: a `sent`/`delivered`
 * event exists, and there is no `open` and no `click`. Pure over the event log;
 * returned sorted for a deterministic send order.
 */
export function nonEngagedSubscribers(events: EngagementEvent[]): string[] {
  const received = new Set<string>();
  const engaged = new Set<string>();
  for (const e of events) {
    if (e.type === "sent" || e.type === "delivered") received.add(e.subscriberId);
    else if (e.type === "open" || e.type === "click") engaged.add(e.subscriberId);
  }
  return [...received].filter((s) => !engaged.has(s)).sort();
}

export interface ResendInput {
  orgId: string;
  /** The campaign whose non-openers/non-clickers we resend to. */
  originalCampaignId: string;
  listId: string;
  /** Usually a fresh subject line for the second attempt. */
  subject: string;
  template: EmailTemplate;
  throttle?: SendThrottle;
}

export interface ResendResult {
  resendCampaignId: string;
  /** Non-engaged recipients identified. */
  targeted: number;
  sent: number;
  suppressed: number;
  /** Already resent on a prior trigger (idempotency) — makes a second call a no-op. */
  alreadySent: number;
  unknown: number;
}

/**
 * Compute the non-engaged set for `originalCampaignId` and resend once to it.
 * Idempotent: `sendToSubscriber` claims each `(resend-campaign, subscriber)`
 * pair, so re-invoking resolves to `alreadySent` for everyone and sends nothing.
 */
export async function resendToNonEngaged(
  stores: Stores,
  sender: EmailSender,
  magic: MagicLinkSigner,
  clock: Clock,
  input: ResendInput,
): Promise<ResendResult> {
  const events = await stores.events.all(input.orgId, input.originalCampaignId);
  const targets = nonEngagedSubscribers(events);
  const campaignId = resendCampaignId(input.originalCampaignId);

  const result: ResendResult = { resendCampaignId: campaignId, targeted: targets.length, sent: 0, suppressed: 0, alreadySent: 0, unknown: 0 };
  for (const subscriberId of targets) {
    const r = await sendToSubscriber(stores, sender, magic, clock, {
      orgId: input.orgId,
      campaignId,
      subscriberId,
      listId: input.listId,
      subject: input.subject,
      template: input.template,
      throttle: input.throttle,
    });
    if (r.sent) result.sent++;
    else if (r.reason === "suppressed") result.suppressed++;
    else if (r.reason === "already-sent") result.alreadySent++;
    else if (r.reason === "unknown-subscriber") result.unknown++;
  }
  return result;
}
