/**
 * Ports (hexagonal boundaries) for the vertical slice.
 *
 * Domain logic depends only on these interfaces, so it runs against in-memory
 * adapters in tests and against DynamoDB / SES / KMS in production — no rewrite.
 */
import type {
  EmailArchive,
  EngagementEvent,
  List,
  Subscriber,
  Subscription,
  SuppressionEntry,
} from "@addressium/core";

export interface SubscriberStore {
  get(orgId: string, sub: string): Promise<Subscriber | undefined>;
  findByEmail(orgId: string, email: string): Promise<Subscriber | undefined>;
  put(sub: Subscriber): Promise<void>;
}

export interface SubscriptionStore {
  get(orgId: string, sub: string, listId: string): Promise<Subscription | undefined>;
  put(s: Subscription): Promise<void>;
  listConfirmed(orgId: string, listId: string): Promise<Subscription[]>;
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

/** What actually puts mail on the wire (SES in prod; capture in tests). */
export interface SentMessage {
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

export interface Clock {
  now(): Date;
}

export interface Stores {
  subscribers: SubscriberStore;
  subscriptions: SubscriptionStore;
  lists: ListStore;
  suppression: SuppressionStore;
  archive: ArchiveStore;
  events: EventStore;
}
