/**
 * Ports (hexagonal boundaries) for the vertical slice.
 *
 * Domain logic depends only on these interfaces, so it runs against in-memory
 * adapters in tests and against DynamoDB / SES / KMS in production — no rewrite.
 */
import type {
  AlertConfig,
  Campaign,
  CampaignSeries,
  EmailArchive,
  EngagementEvent,
  EntitlementSync,
  List,
  Organization,
  Subscriber,
  Subscription,
  SuppressionEntry,
} from "@addressium/core";
import type { EmailTemplate } from "./render.js";

/** The unit of work sent through the queue and produced by a schedule firing. */
export interface SendDescriptor {
  orgId: string;
  campaignId: string;
  listId: string;
  subject: string;
  template: EmailTemplate;
  /**
   * Recipient window for SQS fan-out of large lists. Absent → the whole list is
   * a candidate for fan-out; present → send only this slice of confirmed
   * recipients (offset/limit over the confirmed set).
   */
  slice?: { offset: number; limit: number };
}

/**
 * Paces sends to respect the SES account/org rate. `acquire` resolves once a
 * send token is available (TokenBucket in prod; immediate in tests).
 */
export interface SendThrottle {
  acquire(n?: number): Promise<void>;
}

export interface OrganizationStore {
  get(orgId: string): Promise<Organization | undefined>;
  put(org: Organization): Promise<void>;
  list(): Promise<Organization[]>;
}

export interface SubscriberStore {
  get(orgId: string, sub: string): Promise<Subscriber | undefined>;
  findByEmail(orgId: string, email: string): Promise<Subscriber | undefined>;
  put(sub: Subscriber): Promise<void>;
}

export interface SubscriptionStore {
  get(orgId: string, sub: string, listId: string): Promise<Subscription | undefined>;
  put(s: Subscription): Promise<void>;
  listConfirmed(orgId: string, listId: string): Promise<Subscription[]>;
  /** All of a subscriber's subscriptions across lists (preference center, unsub-all). */
  listBySubscriber(orgId: string, subscriberId: string): Promise<Subscription[]>;
}

export interface ListStore {
  get(orgId: string, listId: string): Promise<List | undefined>;
  put(l: List): Promise<void>;
}

export interface SuppressionStore {
  /** Suppressed for this org given the deployment scope (§4.13). */
  isSuppressed(orgId: string, email: string): Promise<boolean>;
  add(e: SuppressionEntry): Promise<void>;
}

export interface ArchiveStore {
  get(orgId: string, campaignId: string): Promise<EmailArchive | undefined>;
  put(a: EmailArchive): Promise<void>;
}

export interface EventStore {
  append(e: EngagementEvent): Promise<void>;
  all(orgId: string, campaignId: string): Promise<EngagementEvent[]>;
}

export interface EntitlementStore {
  put(e: EntitlementSync): Promise<void>;
  latest(orgId: string, subscriberId: string): Promise<EntitlementSync | undefined>;
}

/** Idempotency guard: claim a campaign send exactly once (SQS is at-least-once). */
export interface SendClaimStore {
  /** True if newly claimed (dispatch it); false if already dispatched. */
  claim(orgId: string, campaignId: string): Promise<boolean>;
}

export interface CampaignStore {
  get(orgId: string, campaignId: string): Promise<Campaign | undefined>;
  put(c: Campaign): Promise<void>;
}

export interface CampaignSeriesStore {
  get(orgId: string, seriesId: string): Promise<CampaignSeries | undefined>;
  put(s: CampaignSeries): Promise<void>;
}

/** Per-org deliverability alert configuration (SNS topic + thresholds, §4.18). */
export interface AlertConfigStore {
  get(orgId: string): Promise<AlertConfig | undefined>;
  put(config: AlertConfig): Promise<void>;
}

/** The payload published to an org's SNS topic on a threshold breach. */
export interface AlertMessage {
  orgId: string;
  campaignId: string;
  at: string;
  breaches: Array<{ metric: string; level: "warn" | "halt"; value: number; threshold: number }>;
  action: "warned" | "halted";
}

/** Publishes deliverability alerts (SNS in prod; captured in tests). */
export interface AlertPublisher {
  publish(topicArn: string, message: AlertMessage): Promise<void>;
}

/** What actually puts mail on the wire (SES in prod; capture in tests). */
export interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  /** RFC 8058 one-click unsubscribe header value. */
  listUnsubscribe: string;
}
export interface EmailSender {
  send(msg: SentMessage): Promise<void>;
}

/** Signs & verifies the internal double-opt-in confirmation token (HMAC). */
export interface ConfirmationTokenSigner {
  sign(payload: { orgId: string; sub: string; listId: string; exp: number }): string;
  verify(token: string): { orgId: string; sub: string; listId: string; exp: number };
}

/** Mints the per-recipient magic-link JWT for editorial links (§4.9). */
export interface MagicLinkSigner {
  /** Returns a signed ES256 JWT for the given subscriber. */
  mint(input: {
    orgId: string;
    sub: string;
    entitlement: "free" | "paid";
    entitlementAsof?: string;
  }): Promise<string>;
}

/** Enqueue a send for the sender to consume (SQS in prod). */
export interface SendQueue {
  enqueue(descriptor: SendDescriptor): Promise<void>;
}

/**
 * Schedules future sends (EventBridge Scheduler in prod). One-off schedules
 * target the send queue directly and auto-delete after firing; recurring
 * schedules target a launch handler that builds each edition.
 */
export interface CampaignScheduler {
  scheduleOneOff(input: { name: string; at: Date; descriptor: SendDescriptor }): Promise<void>;
  scheduleRecurring(input: {
    name: string;
    /** cron/rate expression, e.g. "cron(0 6 * * ? *)". */
    cron: string;
    timezone: string;
    payload: unknown;
  }): Promise<void>;
  cancel(name: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Stores {
  organizations: OrganizationStore;
  subscribers: SubscriberStore;
  subscriptions: SubscriptionStore;
  lists: ListStore;
  suppression: SuppressionStore;
  archive: ArchiveStore;
  events: EventStore;
  entitlements: EntitlementStore;
  sendClaims: SendClaimStore;
  campaigns: CampaignStore;
  series: CampaignSeriesStore;
  alerts: AlertConfigStore;
}
