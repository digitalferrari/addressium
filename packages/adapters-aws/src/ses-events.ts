/**
 * Parsing for the SES event feed (docs/ARCHITECTURE.md §4.5, #184).
 *
 * The events Lambda is subscribed to an SNS topic fed by the per-org SES
 * configuration set. SNS delivers `{Records:[{Sns:{Message:"<json>"}}]}`, not
 * the SES notification itself, and that notification is shaped quite differently
 * from our internal event — so a payload must be unwrapped and normalized
 * before anything can act on it.
 *
 * This lives in the adapter layer (not the Lambda entrypoint) because it is
 * pure AWS-shape translation, and because keeping it here makes it directly
 * unit-testable.
 */
import { createHash } from "node:crypto";
import { SES_TAG, decodeTag } from "./ses.js";

/** Our internal, already-resolved shape (direct invoke and tests). */
export interface Notification {
  eventType: "Open" | "Click" | "Bounce" | "Complaint";
  orgId: string;
  campaignId: string;
  subscriberId: string;
  /** Full clicked URL (token in fragment) for Click events. */
  link?: string;
  /** Present for Bounce/Complaint. */
  email?: string;
  listId?: string;
  /** SES bounce classification; only `Permanent` may suppress. */
  bounceType?: string;
  /** SES message id, used to make at-least-once delivery idempotent. */
  messageId?: string;
  /** Stable id for THIS occurrence — see EngagementEvent.eventId (#183). */
  eventId?: string;
}

/** The subset of the SES event-publishing payload we consume. */
export interface SesNotification {
  eventType?: string;
  /** Legacy SES/SNS notifications use this key instead of `eventType`. */
  notificationType?: string;
  mail?: {
    messageId?: string;
    timestamp?: string;
    destination?: string[];
    tags?: Record<string, string[]>;
  };
  bounce?: {
    bounceType?: string;
    bouncedRecipients?: Array<{ emailAddress?: string }>;
    timestamp?: string;
  };
  complaint?: { complainedRecipients?: Array<{ emailAddress?: string }>; timestamp?: string };
  click?: { link?: string; timestamp?: string };
  open?: { timestamp?: string };
  delivery?: { timestamp?: string };
}

/**
 * Peel the SNS (or SQS) envelope. Returns the inner payloads; a record whose
 * body isn't JSON is skipped rather than failing its batch peers.
 */
export function unwrap(event: unknown): unknown[] {
  const e = event as { Records?: Array<{ Sns?: { Message?: string }; body?: string }> };
  if (!Array.isArray(e?.Records)) return [event];
  const out: unknown[] = [];
  for (const r of e.Records) {
    const raw = r?.Sns?.Message ?? r?.body;
    if (typeof raw !== "string") continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      console.error("events: record body was not JSON", { sample: raw.slice(0, 120) });
    }
  }
  return out;
}

/** SES event type -> the internal type we act on. Others are acknowledged. */
const ACTIONABLE: Record<string, Notification["eventType"] | undefined> = {
  Open: "Open",
  Click: "Click",
  Bounce: "Bounce",
  Complaint: "Complaint",
};

/**
 * Normalize one payload into a `Notification`, or undefined when it can't be
 * resolved to a subscriber.
 */
export function normalize(input: unknown): Notification | undefined {
  const x = input as SesNotification & Partial<Notification>;
  if (!x || typeof x !== "object") return undefined;

  // Already-resolved internal shape (direct invoke / tests).
  if (typeof x.orgId === "string" && typeof x.subscriberId === "string" && x.eventType) {
    return x as Notification;
  }

  const rawType = x.eventType ?? x.notificationType;
  const eventType = rawType ? ACTIONABLE[rawType] : undefined;
  if (!eventType) return undefined;

  const tags = x.mail?.tags ?? {};
  const tag = (name: string): string | undefined => {
    const v = tags[name]?.[0];
    if (!v) return undefined;
    try {
      return decodeTag(v);
    } catch {
      return undefined;
    }
  };
  const orgId = tag(SES_TAG.org);
  const campaignId = tag(SES_TAG.campaign);
  const subscriberId = tag(SES_TAG.subscriber);
  // No correlation tags => the message predates tagging or wasn't sent by us.
  if (!orgId || !campaignId || !subscriberId) return undefined;

  const email =
    x.bounce?.bouncedRecipients?.[0]?.emailAddress ??
    x.complaint?.complainedRecipients?.[0]?.emailAddress ??
    x.mail?.destination?.[0];

  // The provider's own timestamp for this occurrence. Two REDELIVERIES of one
  // notification share it (so they collapse); two genuine opens do not (so both
  // are kept). Falling back to the mail timestamp is safe — it is constant per
  // message, so at worst repeat events of the same type collapse, which is
  // strictly better than counting phantoms.
  const occurredAt =
    x.bounce?.timestamp ??
    x.complaint?.timestamp ??
    x.click?.timestamp ??
    x.open?.timestamp ??
    x.delivery?.timestamp ??
    x.mail?.timestamp;

  const messageId = x.mail?.messageId;
  const eventId = messageId
    ? createHash("sha256")
        .update(`${messageId}|${eventType}|${occurredAt ?? ""}`)
        .digest("hex")
        .slice(0, 32)
    : undefined;

  return {
    eventType,
    orgId,
    campaignId,
    subscriberId,
    email,
    link: x.click?.link,
    bounceType: x.bounce?.bounceType,
    messageId,
    eventId,
  };
}
