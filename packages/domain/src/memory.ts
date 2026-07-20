/**
 * In-memory adapters for the ports. Used by tests and local dev; the DynamoDB /
 * SES implementations live in the services and satisfy the same interfaces.
 */
import type {
  EmailArchive,
  EngagementEvent,
  EntitlementSync,
  List,
  Subscriber,
  Subscription,
  SuppressionEntry,
} from "@addressium/core";
import type {
  ArchiveStore,
  EmailSender,
  EntitlementStore,
  EventStore,
  ListStore,
  SentMessage,
  Stores,
  SubscriberStore,
  SubscriptionStore,
  SuppressionStore,
} from "./ports.js";

const subKey = (o: string, s: string) => `${o}#${s}`;
const subnKey = (o: string, s: string, l: string) => `${o}#${s}#${l}`;

export class MemSubscribers implements SubscriberStore {
  private byId = new Map<string, Subscriber>();
  async get(orgId: string, sub: string) {
    return this.byId.get(subKey(orgId, sub));
  }
  async findByEmail(orgId: string, email: string) {
    for (const s of this.byId.values()) {
      if (s.orgId === orgId && s.email === email.toLowerCase()) return s;
    }
    return undefined;
  }
  async put(sub: Subscriber) {
    this.byId.set(subKey(sub.orgId, sub.sub), sub);
  }
}

export class MemSubscriptions implements SubscriptionStore {
  private map = new Map<string, Subscription>();
  async get(orgId: string, sub: string, listId: string) {
    return this.map.get(subnKey(orgId, sub, listId));
  }
  async put(s: Subscription) {
    this.map.set(subnKey(s.orgId, s.subscriberId, s.listId), s);
  }
  async listConfirmed(orgId: string, listId: string) {
    return [...this.map.values()].filter(
      (s) => s.orgId === orgId && s.listId === listId && s.status === "confirmed",
    );
  }
}

export class MemLists implements ListStore {
  private map = new Map<string, List>();
  async get(orgId: string, listId: string) {
    return this.map.get(subKey(orgId, listId));
  }
  async put(l: List) {
    this.map.set(subKey(l.orgId, l.listId), l);
  }
}

export class MemSuppression implements SuppressionStore {
  private set = new Set<string>();
  async isSuppressed(orgId: string, email: string) {
    return this.set.has(subKey(orgId, email.toLowerCase()));
  }
  async add(e: SuppressionEntry) {
    this.set.add(subKey(e.orgId, e.email.toLowerCase()));
  }
}

export class MemArchive implements ArchiveStore {
  private map = new Map<string, EmailArchive>();
  async get(orgId: string, campaignId: string) {
    return this.map.get(subKey(orgId, campaignId));
  }
  async put(a: EmailArchive) {
    this.map.set(subKey(a.orgId, a.campaignId), a);
  }
}

export class MemEvents implements EventStore {
  private list: EngagementEvent[] = [];
  async append(e: EngagementEvent) {
    this.list.push(e);
  }
  async all(orgId: string, campaignId: string) {
    return this.list.filter((e) => e.orgId === orgId && e.campaignId === campaignId);
  }
}

export class MemEntitlements implements EntitlementStore {
  private map = new Map<string, EntitlementSync>();
  async put(e: EntitlementSync) {
    this.map.set(subKey(e.orgId, e.subscriberId), e);
  }
  async latest(orgId: string, subscriberId: string) {
    return this.map.get(subKey(orgId, subscriberId));
  }
}

/** Captures "sent" mail so tests can inspect exactly what would go out. */
export class CaptureSender implements EmailSender {
  public sent: SentMessage[] = [];
  async send(msg: SentMessage) {
    this.sent.push(msg);
  }
}

export function memStores(): Stores {
  return {
    subscribers: new MemSubscribers(),
    subscriptions: new MemSubscriptions(),
    lists: new MemLists(),
    suppression: new MemSuppression(),
    archive: new MemArchive(),
    events: new MemEvents(),
    entitlements: new MemEntitlements(),
  };
}
